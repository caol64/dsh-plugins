/**
 * Invoke one `mdcli` command and classify its outcome.
 *
 * Arguments are passed as an array (never through a shell). The child is
 * cancelled with the tool's abort signal and bounded by a per-attempt timeout;
 * the caller decides whether a classified failure is worth a single retry.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Marker mdcli appends when `--truncate` shortened the document. */
export const TRUNCATE_MARK = "…[truncated]";

/** stderr line mdcli prints after a successful `-s` save. */
const SAVED_PREFIX = "Article saved to:";

/** How long a SIGTERM'd child gets before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** Cap on retained stderr so a chatty page cannot flood tool output. */
const STDERR_KEEP_CHARS = 8_000;

/**
 * @typedef {{ mode: 'parse' | 'read', target: unknown, save: unknown,
 *   maxTokens: unknown, noVerifySsl: unknown, prettify: unknown }} RunRequest
 *
 * @typedef {{ kind: 'ok', stdout: string, stderrLines: string[], savedPath: string | null,
 *   truncated: boolean, argv: string[] }
 * | { kind: 'timeout', argv: string[], stderrLines: string[] }
 * | { kind: 'aborted', argv: string[], stderrLines: string[] }
 * | { kind: 'error', exitCode: number | null, signal: string | null, message: string,
 *     stderr: string, stderrLines: string[], argv: string[] }} RunResult
 */

/**
 * Whether `value` is a usable positive integer token budget.
 * @param {unknown} value - candidate (never coerced from strings).
 * @returns {value is number} true for integers >= 1.
 */
export function isTokenBudget(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Build the argv passed to mdcli for one request. Exported for tests: the
 * mapping is the contract (tool parameter -> CLI option).
 * @param {RunRequest} request - normalized tool arguments.
 * @returns {string[]} argument vector excluding the executable itself.
 */
export function buildArgs(request) {
    const input = String(request.target);
    /** @type {string[]} */
    const args = request.mode === "read" ? ["read", input] : ["parse", input];

    // `--truncate` is only forwarded when explicitly requested: its bare form
    // would silently apply mdcli's 800-token default.
    if (request.mode === "parse" && isTokenBudget(request.maxTokens)) {
        args.push("--truncate", String(request.maxTokens));
    }
    if (request.mode === "parse" && typeof request.save === "string" && request.save !== "") {
        args.push("--save", request.save);
    }
    if (request.mode === "read" && request.prettify === true) {
        args.push("--prettify");
    }
    if (request.noVerifySsl === true) {
        args.push("--no-verify-ssl");
    }
    return args;
}

/**
 * Read the last complete `Article saved to:` line from mdcli's stderr.
 * @param {string[]} lines - captured stderr lines in order.
 * @returns {string | null} the absolute saved path, or null when absent.
 */
export function extractSavedPath(lines) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const text = lines[i].trim();
        if (text.startsWith(SAVED_PREFIX)) {
            const path = text.slice(SAVED_PREFIX.length).trim();
            if (path) return path;
        }
    }
    return null;
}

/**
 * Keep only the trailing stderr lines worth showing as progress notes.
 * @param {string[]} lines - captured stderr lines in order.
 * @param {number} [limit] - how many trailing lines to retain.
 * @returns {string[]} filtered warnings.
 */
export function progressWarnings(lines, limit = 3) {
    return lines
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith(SAVED_PREFIX) && !line.startsWith("Error:"))
        .slice(-limit);
}

/**
 * Pull the most specific `Error: ...` message out of stderr.
 * @param {string} stderr - captured stderr text.
 * @param {number | null} exitCode - child exit code, if it exited.
 * @returns {string} human-readable failure message.
 */
export function errorMessage(stderr, exitCode) {
    const lines = String(stderr ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].startsWith("Error:")) return lines[i].slice("Error:".length).trim();
    }
    const tail = lines.at(-1);
    if (tail) return tail;
    return `mdcli exited with code ${exitCode ?? "unknown"} and no error message`;
}

/**
 * Spawn mdcli once.
 * @param {{ bin: string, args: string[], cwd: string, timeoutMs: number,
 *   signal?: AbortSignal }} options - invocation parameters.
 * @returns {Promise<RunResult>} classified outcome of this attempt.
 */
export function runMdcli({ bin, args, cwd, timeoutMs, signal }) {
    return new Promise((resolve) => {
        /** @type {import('node:child_process').ChildProcess | undefined} */
        let child;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let stdout = "";
        let stderr = "";
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");

        const stderrLines = () =>
            stderr
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);

        /** @type {NodeJS.Timeout | undefined} */
        let killTimer;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };

        const timer = setTimeout(() => {
            timedOut = true;
            child?.kill("SIGTERM");
            killTimer = setTimeout(() => child?.kill("SIGKILL"), KILL_GRACE_MS);
        }, timeoutMs);

        const onAbort = () => {
            aborted = true;
            child?.kill("SIGTERM");
            killTimer = setTimeout(() => child?.kill("SIGKILL"), KILL_GRACE_MS);
        };

        if (signal?.aborted) {
            resolve({ kind: "aborted", argv: args, stderrLines: [] });
            return;
        }

        try {
            child = spawn(bin, args, {
                cwd,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            finish({
                kind: "error",
                exitCode: null,
                signal: null,
                message: error.message,
                stderr: "",
                stderrLines: [],
                argv: args,
            });
            return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", (chunk) => {
            stdout += stdoutDecoder.write(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            const text = stderrDecoder.write(chunk);
            // Keep the tail bounded but always leave room for the final message.
            stderr =
                stderr.length + text.length > STDERR_KEEP_CHARS * 2
                    ? stderr.slice(-STDERR_KEEP_CHARS) + text
                    : stderr + text;
        });

        child.on("error", (error) => {
            finish({
                kind: "error",
                exitCode: null,
                signal: null,
                message: error.message,
                stderr,
                stderrLines: stderrLines(),
                argv: args,
            });
        });

        child.on("close", (code, closeSignal) => {
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
            const lines = stderrLines();
            if (aborted) {
                finish({ kind: "aborted", argv: args, stderrLines: lines });
                return;
            }
            if (timedOut) {
                finish({ kind: "timeout", argv: args, stderrLines: lines });
                return;
            }
            if (code === 0) {
                finish({
                    kind: "ok",
                    stdout,
                    stderrLines: lines,
                    savedPath: extractSavedPath(lines),
                    truncated: stdout.trimEnd().endsWith(TRUNCATE_MARK),
                    argv: args,
                });
                return;
            }
            finish({
                kind: "error",
                exitCode: code,
                signal: closeSignal,
                message: errorMessage(stderr, code),
                stderr,
                stderrLines: lines,
                argv: args,
            });
        });
    });
}
