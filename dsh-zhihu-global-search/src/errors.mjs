/**
 * Turn every failure shape (HTTP status, business code, transport error) into
 * one classified outcome with an actionable message and a retry decision.
 *
 * Rules that matter for the model and for the user's bill:
 *  - a refused credential, a bad argument, an exhausted quota and a risk-control
 *    rejection are NOT retried: retrying cannot help and may cost money;
 *  - a timeout, a network error or a 5xx is retried exactly once by the caller;
 *  - caller cancellation is never reported as an upstream failure.
 *
 * Messages must never include the Access Secret. Only `formatMessage()` output
 * from the upstream body is echoed, and secrets are redacted there.
 */

/** @typedef {'auth'|'quota'|'risk'|'argument'|'not_found'|'upstream'|'timeout'|'network'|'aborted'|'unconfigured'} FailureKind */

/** Business codes of the Zhihu Open Platform and what they mean here. */
export const BUSINESS_CODES = Object.freeze({
    10001: "argument",
    20001: "auth",
    30001: "quota",
    30002: "quota",
    30003: "risk",
    40004: "not_found",
    40005: "upstream",
    40006: "upstream",
    50002: "upstream",
    90001: "upstream",
});

/** Failure kinds whose cause may disappear on its own. */
const RETRYABLE = new Set(["timeout", "network", "upstream"]);

/** Prefix kept from a non-JSON response body. */
const SNIPPET_CHARS = 200;

/**
 * @typedef {{ kind: FailureKind, text: string, retryable: boolean,
 *   code?: number, status?: number }} Failure
 */

/**
 * Whether a failure may be retried once.
 * @param {Failure} failure - classified failure.
 * @returns {boolean} true when one more attempt is reasonable.
 */
export function shouldRetry(failure) {
    return Boolean(failure) && RETRYABLE.has(failure.kind);
}

/**
 * Map an HTTP status to a failure kind when the body carries no usable code.
 * @param {number} status - HTTP status.
 * @returns {FailureKind} failure kind.
 */
export function kindForStatus(status) {
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "not_found";
    if (status === 429) return "quota";
    if (status >= 500) return "upstream";
    if (status >= 400) return "argument";
    return "upstream";
}

/**
 * Redact a credential-shaped token from text before it can reach a model or a
 * log. Anything the plugin knows to be a secret is replaced wholesale earlier;
 * this is the last line for echo-back of an authenticated request.
 * @param {string} text - untrusted text.
 * @param {string[]} secrets - known secret values.
 * @returns {string} text with every known secret removed.
 */
export function redact(text, secrets = []) {
    let out = String(text);
    for (const secret of secrets) {
        if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("***");
    }
    return out;
}

/**
 * Trim a response body to a short, single-line snippet for diagnostics.
 * @param {string} body - response body text.
 * @param {string[]} secrets - known secret values.
 * @returns {string} a redacted prefix.
 */
export function bodySnippet(body, secrets = []) {
    const flat = String(body ?? "")
        .replace(/\s+/gu, " ")
        .trim();
    return redact(flat.slice(0, SNIPPET_CHARS), secrets);
}

/**
 * Actionable text for each failure kind.
 * @param {FailureKind} kind - failure kind.
 * @param {{ code?: number, status?: number, message?: string, snippet?: string,
 *   timeoutMs?: number, ref?: string, baseURL?: string }} context - failure context.
 * @returns {string} message for the model (and, via the tool result, the user).
 */
export function failureText(kind, context = {}) {
    const detail = context.message ? ` 上游消息：${context.message}` : "";
    const code = context.code !== undefined ? `（Code ${context.code}）` : "";
    const status = context.status !== undefined ? `（HTTP ${context.status}）` : "";
    const ref = context.ref ?? "ZHIHU_ACCESS_SECRET";
    const quote = context.snippet ? ` 响应片段：${context.snippet}` : "";
    switch (kind) {
        case "unconfigured":
            return `尚未配置知乎 Access Secret：请在 设置 → 知乎全网搜索 中填写并保存，或设置环境变量 ${ref} 后重试。Access Secret 可在 https://developer.zhihu.com 申请。`;
        case "auth":
            return `知乎鉴权失败${code}${status}：Access Secret 无效、已过期或没有全网搜索权限。请在 设置 → 知乎全网搜索 中重新填写，或在 https://developer.zhihu.com 确认该密钥的权限。${detail}`;
        case "quota":
            return `知乎额度不足或被限频${code}${status}：全网搜索按次计费，当日免费额度可能已用尽。请稍后再试或在知乎开放平台查看额度；不要立即重复调用。${detail}`;
        case "risk":
            return `知乎风控拒绝了这次请求${code}${status}：请稍后再试或换个查询词；不要立即重复调用同一查询。${detail}`;
        case "argument":
            return `知乎拒绝了请求参数${code}${status}：请检查 query 与 filter 的写法。${detail}`;
        case "not_found":
            return `知乎返回未找到${code}${status}：请调整查询内容后重试。${detail}`;
        case "timeout":
            return `知乎全网搜索超时（${context.timeoutMs ?? "?"}ms 未返回）。请重试；若持续超时可在插件配置中调大 timeoutMs。`;
        case "network":
            return `无法连接知乎开放平台${context.baseURL ? `（${context.baseURL}）` : ""}：${context.message ?? "网络错误"}。请检查网络或代理后重试。`;
        case "aborted":
            return "搜索已被取消。";
        case "upstream":
        default:
            return `知乎开放平台暂时不可用${code}${status}${detail}${quote}。请稍后重试。`;
    }
}

/**
 * Classify an HTTP response wrapper (already-parsed JSON envelope or raw body).
 * @param {{ status: number, code?: number, message?: string, snippet?: string }} response - response summary.
 * @param {{ ref?: string, secrets?: string[] }} [options] - redaction context.
 * @returns {Failure} classified failure.
 */
export function failureFromResponse(response, options = {}) {
    const codeKind = response.code !== undefined ? BUSINESS_CODES[response.code] : undefined;
    const kind = codeKind ?? kindForStatus(response.status);
    const message = response.message ? redact(String(response.message), options.secrets ?? []) : undefined;
    const snippet = response.snippet ? bodySnippet(response.snippet, options.secrets ?? []) : undefined;
    return {
        kind,
        code: response.code,
        status: response.status,
        retryable: shouldRetry({ kind }),
        text: failureText(kind, { code: response.code, status: response.status, message, snippet, ref: options.ref }),
    };
}

/**
 * Classify an exception thrown by `fetch` or by reading the body.
 * Abort signals are told apart: a caller-driven abort propagates as-is so the
 * harness records a cancellation, while our own timeout is reported as such.
 * @param {unknown} error - thrown value.
 * @param {{ timeout: boolean, callerSignal?: AbortSignal, timeoutMs?: number, baseURL?: string }} context - abort context.
 * @returns {Failure} classified failure.
 */
export function failureFromError(error, context) {
    if (context.callerSignal?.aborted) {
        return { kind: "aborted", retryable: false, text: failureText("aborted") };
    }
    if (context.timeout || error?.name === "TimeoutError") {
        return {
            kind: "timeout",
            retryable: true,
            text: failureText("timeout", { timeoutMs: context.timeoutMs }),
        };
    }
    if (error?.name === "AbortError") {
        return { kind: "aborted", retryable: false, text: failureText("aborted") };
    }
    return {
        kind: "network",
        retryable: true,
        text: failureText("network", { message: error?.message ?? String(error), baseURL: context.baseURL }),
    };
}