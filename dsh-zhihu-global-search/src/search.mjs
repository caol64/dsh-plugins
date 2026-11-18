/**
 * One global-search call, end to end: resolve the secret, build the request,
 * fetch with a timeout bound to the caller's cancellation, classify failures,
 * retry once on a transient kind, and project the response.
 *
 * The pipeline is exported with its side effects injected (`fetchImpl`) so the
 * whole control flow — including the retry budget and the abort handling — is
 * exercisable offline.
 */
import { createSecretResolver } from "./credentials.mjs";
import { buildUrl, normalizeRequest } from "./endpoint.mjs";
import { bodySnippet, failureFromError, failureFromResponse, failureText, redact } from "./errors.mjs";
import { decodeResponse, locatedItems, projectItem } from "./respond.mjs";
import { buildOutput, renderMarkdown } from "./result.mjs";

/** Request header carrying the credential. */
const AUTH_HEADER = "Authorization";

/**
 * Build the request headers. The secret appears only here, never in a result.
 * @param {string} secret - Access Secret.
 * @param {number} nowMs - current epoch milliseconds.
 * @returns {Record<string, string>} headers.
 */
export function buildHeaders(secret, nowMs) {
    return {
        [AUTH_HEADER]: `Bearer ${secret}`,
        "X-Request-Timestamp": String(Math.floor(nowMs / 1000)),
        Accept: "application/json",
    };
}

/**
 * An error whose message is already actionable text for the model.
 */
export class SearchFailure extends Error {
    /**
     * @param {string} text - actionable message.
     * @param {{ kind?: string, retryable?: boolean }} [meta] - classification.
     */
    constructor(text, meta = {}) {
        super(text);
        this.name = "SearchFailure";
        this.kind = meta.kind ?? "upstream";
        this.retryable = meta.retryable ?? false;
    }
}

/**
 * Perform one HTTP attempt and decode it.
 * @param {{ url: URL, headers: Record<string, string>, timeoutMs: number,
 *   callerSignal?: AbortSignal, fetchImpl: typeof fetch, secrets: string[] }} attempt - attempt input.
 * @returns {Promise<{ kind: "ok", decoded: ReturnType<typeof decodeResponse> } | { kind: "fail", failure: import("./errors.mjs").Failure }>} attempt outcome.
 */
async function attemptOnce(attempt) {
    const timeout = AbortSignal.timeout(attempt.timeoutMs);
    const signal = attempt.callerSignal ? AbortSignal.any([attempt.callerSignal, timeout]) : timeout;
    /** @type {Response} */
    let response;
    try {
        response = await attempt.fetchImpl(attempt.url, {
            method: "GET",
            headers: attempt.headers,
            signal,
            redirect: "follow",
        });
    } catch (error) {
        return {
            kind: "fail",
            failure: failureFromError(error, {
                timeout: timeout.aborted,
                callerSignal: attempt.callerSignal,
                timeoutMs: attempt.timeoutMs,
                baseURL: attempt.url.origin,
            }),
        };
    }
    let text;
    try {
        text = await response.text();
    } catch (error) {
        return {
            kind: "fail",
            failure: failureFromError(error, {
                timeout: timeout.aborted,
                callerSignal: attempt.callerSignal,
                timeoutMs: attempt.timeoutMs,
                baseURL: attempt.url.origin,
            }),
        };
    }
    const decoded = decodeResponse({ status: response.status, text });
    // A non-2xx status always fails, even when the body carries `Code: 0`;
    // a 2xx status with a non-zero `Code` is a business failure.
    if (!response.ok) {
        return {
            kind: "fail",
            failure: failureFromResponse(
                {
                    status: response.status,
                    code: decoded.code,
                    message: decoded.message,
                    snippet: decoded.json ? undefined : decoded.body,
                },
                { secrets: attempt.secrets },
            ),
        };
    }
    if (!decoded.json) {
        return {
            kind: "fail",
            failure: failureFromResponse(
                { status: response.status, message: "响应不是 JSON", snippet: bodySnippet(decoded.body, attempt.secrets) },
                { secrets: attempt.secrets },
            ),
        };
    }
    return { kind: "ok", decoded };
}

/**
 * Run one search and return the tool output value.
 * `maxChars` bounds the rendered text: the pipeline renders it here (with the
 * same budget the tool's render uses) only to learn whether it was cut, and
 * reports that through `truncated` instead of mutating the value later.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {{ config: { baseURL: string, timeoutMs: number }, ref?: string,
 *   resolveSecret: () => Promise<{ value: string, source: string } | undefined>,
 *   signal?: AbortSignal, fetchImpl?: typeof fetch, now?: () => number,
 *   maxChars: number }} context - execution context.
 * @returns {Promise<Record<string, any>>} the tool output value.
 * @throws {SearchFailure} with actionable text.
 * @throws {Error} `AbortError` when the caller cancelled.
 */
export async function searchGlobal(args, context) {
    const fetchImpl = context.fetchImpl ?? globalThis.fetch;
    const now = context.now ?? Date.now;
    const request = normalizeRequest(args);
    const warnings = [...request.warnings];

    const hit = await context.resolveSecret();
    if (hit === undefined) throw new SearchFailure(failureText("unconfigured", { ref: context.ref }));
    const secrets = [hit.value];

    const url = buildUrl(context.config.baseURL, request);
    const headers = buildHeaders(hit.value, now());

    /** @type {import("./errors.mjs").Failure | undefined} */
    let failure;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const outcome = await attemptOnce({
            url,
            headers,
            timeoutMs: context.config.timeoutMs,
            callerSignal: context.signal,
            fetchImpl,
            secrets,
        });
        if (outcome.kind === "ok") {
            const decoded = outcome.decoded;
            if (decoded.code !== undefined && decoded.code !== 0) {
                const businessFailure = failureFromResponse(
                    { status: decoded.status, code: decoded.code, message: decoded.message },
                    { secrets, ref: context.ref },
                );
                throw new SearchFailure(businessFailure.text, businessFailure);
            }
            if (attempt > 1) warnings.push("首次请求未完成，已自动重试一次并成功。");
            const output = buildOutput(request, { ...decoded, itemsLocated: locatedItems(decoded) !== undefined }, warnings, {
                projectItem,
            });
            renderMarkdown(output, context.maxChars);
            return output;
        }
        failure = outcome.failure;
        if (failure.kind === "aborted") throw Object.assign(new Error(failure.text), { name: "AbortError" });
        if (!failure.retryable || attempt === 2) break;
    }
    throw new SearchFailure(redact(failure?.text ?? failureText("upstream"), secrets), failure);
}

/**
 * Re-exported for callers that build a resolver next to the pipeline.
 */
export { createSecretResolver };