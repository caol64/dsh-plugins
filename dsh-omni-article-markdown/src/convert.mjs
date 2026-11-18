/**
 * One `md_article` conversion: resolve the target, make sure mdcli exists,
 * run it, retry once on transient failures, and project the canonical result.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { supportsTruncate } from "./env.mjs";
import { classifyFailure, shouldRetry } from "./errors.mjs";
import { buildArgs, isTokenBudget, progressWarnings, runMdcli } from "./run.mjs";

/** Failure text that means mdcli needs a Playwright browser. */
const BROWSER_HINT = /playwright|chromium|executable doesn't exist/i;

/** Remote targets are used verbatim; everything else is a local path. */
const REMOTE = /^https?:\/\//iu;

/** Any other scheme is a mistake worth naming, never a relative file path. */
const FOREIGN_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * @typedef {{ mode: 'parse' | 'read', target: string, save?: string,
 *   maxTokens?: unknown, noVerifySsl?: boolean, prettify?: boolean }} RunRequest
 * @typedef {import('./env.mjs').ProbeResult} ProbeResult
 */

/**
 * Thin seam over the modules that touch the OS, so tests can substitute them.
 * @typedef {{ probe: () => Promise<ProbeResult>, invalidateProbe: () => void,
 *   install: (signal: AbortSignal | undefined) => Promise<{ ok: boolean, log: string[] }>,
 *   installBrowser: (bin: string, signal: AbortSignal | undefined) => Promise<{ ok: boolean, output: string }>,
 *   run: (options: Parameters<typeof runMdcli>[0]) => ReturnType<typeof runMdcli> }} Runtime
 */

/**
 * @typedef {{ exec: { signal: AbortSignal, deferContext?: (message: unknown) => void },
 *   cwd: string, runtime: Runtime,
 *   limits: { timeoutMs: number, allowInstall: boolean },
 *   text: import('./tool.mjs').Strings }} ConvertContext
 */

/**
 * Resolve the model-supplied target to an absolute local path.
 * @param {string} url - target as given.
 * @param {string} cwd - working directory for relative paths.
 * @param {(path: string) => string} notFound - wording for a missing file.
 * @param {(scheme: string) => string} [badScheme] - wording for a non-HTTP scheme.
 * @returns {Promise<string>} absolute path, or the untouched remote URL.
 * @throws {Error} when a local target does not exist as a file.
 */
export async function resolveTarget(url, cwd, notFound, badScheme) {
    if (REMOTE.test(url)) return url;
    const scheme = FOREIGN_SCHEME.exec(url);
    if (scheme) throw new Error(badScheme ? badScheme(scheme[0]) : `Unsupported URL scheme: ${scheme[0]}`);
    const absolute = isAbsolute(url) ? url : resolve(cwd, url);
    let info;
    try {
        info = await stat(absolute);
    } catch {
        throw new Error(notFound(absolute));
    }
    if (!info.isFile()) throw new Error(notFound(absolute));
    return absolute;
}

/**
 * Resolve the `save` argument to a path mdcli can write.
 *
 * mdcli treats `--save PATH` as a directory only when the path already exists
 * as one; otherwise it writes PATH as the file name. So a missing directory
 * would silently become a file, and a "notes/article" style value would fail.
 * A supplied extension means "file" (create the parent); anything else is a
 * directory (create it), matching the documented `-s /path/to/dir` usage.
 * @param {string} save - model-supplied destination, relative or absolute.
 * @param {string} cwd - working directory for relative values.
 * @returns {Promise<string>} absolute directory or file path that exists.
 * @throws {Error} when the destination cannot be created.
 */
export async function resolveSaveTarget(save, cwd) {
    const absolute = isAbsolute(save) ? save : resolve(cwd, save);
    // An extension means a file target, so only its parent must exist. Without
    // one the value is a directory (an existing file of that name keeps working
    // because mdcli's is_dir() check then falls through to the file branch).
    const directory = extname(absolute) === "" ? absolute : dirname(absolute);
    try {
        await mkdir(directory, { recursive: true });
    } catch (error) {
        throw new Error(`cannot create save destination ${absolute}: ${error.message}`);
    }
    return absolute;
}

/**
 * Project a successful attempt into the tool's canonical output value.
 * @param {Extract<import('./run.mjs').RunResult, { kind: 'ok' }>} result - successful attempt.
 * @param {{ mode: 'parse' | 'read', save?: string }} request - requested mode and destination.
 * @param {string[]} notes - warnings accumulated before the attempt.
 * @param {import('./tool.mjs').Strings} text - wording.
 * @returns {Record<string, unknown>} schema-conforming value.
 * @throws {Error} when a successful run produced nothing usable.
 */
export function projectResult(result, request, notes, text) {
    const warnings = [...notes, ...progressWarnings(result.stderrLines)];
    if (request.mode === "read") {
        if (result.stdout.trim() === "") throw new Error(text.emptyOutput);
        return { markdown: result.stdout, truncated: false, mode: "raw_html", warnings };
    }
    if (request.save) {
        return {
            markdown: "",
            saved_path: result.savedPath ?? text.saveUnknown(request.save),
            truncated: result.truncated,
            mode: "saved",
            warnings,
        };
    }
    if (result.stdout.trim() === "") throw new Error(text.emptyOutput);
    return { markdown: result.stdout, truncated: result.truncated, mode: "markdown", warnings };
}

/**
 * Convert one article.
 * @param {{ url: string, max_tokens?: number, save?: string, no_verify_ssl?: boolean,
 *   raw_html?: boolean, prettify?: boolean }} args - tool arguments.
 * @param {ConvertContext} context - runtime seam, working directory, limits, and wording.
 * @returns {Promise<Record<string, unknown>>} canonical tool output.
 * @throws {Error} with model-actionable guidance on failure.
 */
export async function convertArticle(args, context) {
    const { exec, cwd, runtime, limits, text } = context;
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) throw new Error(text.invalidUrl);

    const mode = args.raw_html === true ? "read" : "parse";
    /** @type {string[]} */
    const notes = [];
    if (mode === "read" && isTokenBudget(args.max_tokens)) notes.push(text.truncateIgnored);

    /** @type {RunRequest} */
    const request = {
        mode,
        target: await resolveTarget(url, cwd, text.targetNotFound, text.badScheme),
        save: typeof args.save === "string" && args.save !== "" ? await resolveSaveTarget(args.save, cwd) : undefined,
        maxTokens: mode === "parse" ? args.max_tokens : undefined,
        noVerifySsl: args.no_verify_ssl === true,
        prettify: args.prettify === true,
    };

    const attempt = () => runAttempt(request, { exec, cwd, runtime, limits, text });

    await ensureTool(request, context);
    let result = await attempt();

    if (result.kind === "error" && BROWSER_HINT.test(result.message)) {
        const info = await runtime.probe();
        const install = await runtime.installBrowser(info.bin, exec.signal);
        if (install.ok && !exec.signal.aborted) {
            result = await attempt();
            if (result.kind === "ok") notes.push(text.browserFixed);
        }
    }

    const finish = (outcome) => projectResult(outcome, request, notes, text);

    if (result.kind === "aborted") throw new DOMException("md_article aborted", "AbortError");
    if (result.kind === "ok") return finish(result);

    const failure =
        result.kind === "timeout" ? classifyFailure("", { kind: "timeout" }) : classifyFailure(result.message);
    if (!shouldRetry(failure) || exec.signal.aborted) throw new Error(failure.message);

    const retried = await attempt();
    if (retried.kind === "aborted") throw new DOMException("md_article aborted", "AbortError");
    if (retried.kind === "ok") return finish(retried);
    throw new Error(text.retryFailed(failure.message, describe(retried)));
}

/**
 * Describe a non-ok attempt inside a retry summary.
 * @param {import('./run.mjs').RunResult} result - finished attempt.
 * @returns {string} one-line description.
 */
function describe(result) {
    if (result.kind === "timeout") return "mdcli timeout";
    if (result.kind === "error") return result.message;
    return "mdcli did not finish";
}

/**
 * Ensure mdcli is installed and the requested options are supported.
 * @param {RunRequest} request - normalized request.
 * @param {ConvertContext} context - runtime seam, limits, and wording.
 * @returns {Promise<ProbeResult>} the usable probe result.
 * @throws {Error} when mdcli is missing, uninstallable, or too old.
 */
async function ensureTool(request, { exec, runtime, limits, text }) {
    let info = await runtime.probe();
    if (!info.installed) {
        if (!limits.allowInstall) throw new Error(text.notInstalled);
        exec.deferContext?.({
            role: "user",
            source: { kind: "omni-article-markdown", form: "notice" },
            content: [{ type: "text", text: text.installRunning }],
        });
        const outcome = await runtime.install(exec.signal);
        if (!outcome.ok) throw new Error(`${text.installFailed}${outcome.log.join(" | ")}`);
        runtime.invalidateProbe();
        info = await runtime.probe();
        if (!info.installed) throw new Error(text.notInstalled);
    }
    if (request.mode === "parse" && isTokenBudget(request.maxTokens) && !supportsTruncate(info)) {
        throw new Error(text.oldVersion(info.version ?? "unknown"));
    }
    return info;
}

/**
 * Run mdcli once for a request whose tooling is already ensured.
 * @param {RunRequest} request - normalized request.
 * @param {ConvertContext} context - runtime seam and working directory.
 * @returns {Promise<import('./run.mjs').RunResult>} classified outcome.
 */
async function runAttempt(request, { exec, cwd, runtime, limits }) {
    const info = await runtime.probe();
    return runtime.run({
        bin: info.bin,
        args: buildArgs(request),
        cwd,
        timeoutMs: limits.timeoutMs,
        signal: exec.signal,
    });
}
