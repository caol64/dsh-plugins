/**
 * Install the missing runtime pieces on demand.
 *
 * mdcli is installed into an isolated tool environment (pipx, then uv tool,
 * then a user pip install as a last resort) so the system Python is never
 * modified silently. Playwright Chromium is installed only after mdcli itself
 * reports that the browser is missing.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Package spec used by every install strategy. */
export const PACKAGE = "omni-article-markdown";

/** Successful-install cache lifetime. */
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed-install cache lifetime: short, so a fixed environment retries soon. */
const FAILURE_TTL_MS = 60 * 60 * 1000;

/**
 * Run a command and capture its combined output, never rejecting.
 * @param {string} bin - executable.
 * @param {string[]} args - argument vector.
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options - limits.
 * @returns {Promise<{ ok: boolean, code: number | null, output: string }>} outcome.
 */
export function runCommand(bin, args, { timeoutMs, signal }) {
    return new Promise((resolve) => {
        execFile(
            bin,
            args,
            { timeout: timeoutMs, signal, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
            (error, stdout, stderr) => {
                const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
                if (error) {
                    resolve({
                        ok: false,
                        code: typeof error.code === "number" ? error.code : null,
                        output: output || error.message,
                    });
                    return;
                }
                resolve({ ok: true, code: 0, output });
            },
        );
    });
}

/** Locate an executable by probing `--version`; returns null when absent. */
async function hasCommand(bin, timeoutMs) {
    const result = await runCommand(bin, ["--version"], { timeoutMs: Math.min(timeoutMs, 20_000) });
    return result.ok;
}

/**
 * @typedef {{ ok: boolean, strategy: string | null, log: string[] }} InstallOutcome
 */

/**
 * Install mdcli with the first available strategy.
 * @param {{ timeoutMs: number, signal?: AbortSignal, probe: () => Promise<import('./env.mjs').ProbeResult>,
 *   onProgress?: (line: string) => void }} options - install controls and a
 *   post-install probe used to confirm the binary landed.
 * @returns {Promise<InstallOutcome>} success flag, winning strategy, and log.
 */
export async function installMdcli({ timeoutMs, signal, probe, onProgress = () => {} }) {
    /** @type {string[]} */
    const log = [];
    /** @type {string[]} */
    const failures = [];

    /** @param {string} line */
    const note = (line) => {
        log.push(line);
        onProgress(line);
    };

    /** @type {Array<{ strategy: string, available: () => Promise<boolean>, run: () => Promise<{ ok: boolean, output: string }> }>} */
    const strategies = [
        {
            strategy: "pipx",
            available: () => hasCommand("pipx", timeoutMs),
            run: () => runCommand("pipx", ["install", PACKAGE], { timeoutMs, signal }),
        },
        {
            strategy: "uv",
            available: () => hasCommand("uv", timeoutMs),
            run: () => runCommand("uv", ["tool", "install", PACKAGE], { timeoutMs, signal }),
        },
        {
            strategy: "pip",
            available: () => hasCommand("python3", timeoutMs),
            run: () => runCommand("python3", ["-m", "pip", "install", "--user", PACKAGE], { timeoutMs, signal }),
        },
    ];

    for (const strategy of strategies) {
        if (signal?.aborted) return { ok: false, strategy: null, log: [...log, "安装已取消"] };
        if (!(await strategy.available())) continue;
        note(`尝试通过 ${strategy.strategy} 安装 ${PACKAGE}…`);
        const result = await strategy.run();
        if (!result.ok) {
            failures.push(`${strategy.strategy}: ${tail(result.output)}`);
            note(`${strategy.strategy} 安装失败`);
            continue;
        }
        note(`${strategy.strategy} 安装完成，校验版本…`);
        const probed = await probe();
        if (probed.installed) return { ok: true, strategy: strategy.strategy, log };
        failures.push(
            `${strategy.strategy}: 安装命令成功但无法执行 mdcli（可能不在 PATH；请把插件配置 command 指向 mdcli 绝对路径）`,
        );
        note(`${strategy.strategy} 安装后仍找不到 mdcli`);
    }

    if (failures.length === 0) {
        failures.push("未找到 pipx / uv / python3，无法自动安装");
    }
    return { ok: false, strategy: null, log: [...log, ...failures] };
}

/**
 * Derive the Python interpreter that owns an mdcli entry point, so Playwright
 * is installed into the same virtual environment.
 * @param {string} bin - mdcli executable path (absolute) or bare name.
 * @param {string} cwd - working directory used to resolve a relative path.
 * @returns {Promise<string | null>} interpreter path, or null when unknown.
 */
export async function pythonFor(bin, cwd) {
    if (!bin.includes("/")) return null;
    try {
        const shebang = (await readFile(bin, "utf8")).split("\n", 1)[0] ?? "";
        const match = /^#!\s*(\S+)/.exec(shebang);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Install Playwright Chromium with the interpreter that owns mdcli.
 * @param {{ bin: string, timeoutMs: number, signal?: AbortSignal,
 *   onProgress?: (line: string) => void, cwd?: string }} options - install controls.
 * @returns {Promise<{ ok: boolean, output: string }>} outcome and captured output.
 */
export async function installBrowser({ bin, timeoutMs, signal, onProgress = () => {} }) {
    const python = (await pythonFor(bin, process.cwd())) ?? "python3";
    onProgress(`尝试用 ${python} -m playwright install chromium 安装浏览器…`);
    const result = await runCommand(python, ["-m", "playwright", "install", "chromium"], { timeoutMs, signal });
    if (!result.ok) return { ok: false, output: tail(result.output) };
    return { ok: true, output: tail(result.output) };
}

/**
 * Keep the last few informative lines of a command transcript.
 * @param {string} output - combined stdout/stderr.
 * @param {number} [lines] - how many trailing lines to keep.
 * @returns {string} trimmed tail.
 */
export function tail(output, lines = 4) {
    const kept = String(output ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-lines);
    return kept.join(" | ");
}

/**
 * Cache install outcomes, serializing concurrent attempts so one session never
 * runs two pipx installs at once.
 * @param {(signal?: AbortSignal) => Promise<InstallOutcome>} installer - install function.
 * @returns {{ get: (signal?: AbortSignal) => Promise<InstallOutcome> }} cached accessor.
 */
export function createInstallCache(installer) {
    /** @type {{ at: number, value: InstallOutcome } | null} */
    let entry = null;
    /** @type {Promise<InstallOutcome> | null} */
    let inFlight = null;
    return {
        get(signal) {
            const now = Date.now();
            if (entry) {
                const ttl = entry.value.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
                if (now - entry.at < ttl) return Promise.resolve(entry.value);
            }
            if (inFlight) return inFlight;
            inFlight = installer(signal)
                .then((value) => {
                    entry = { at: Date.now(), value };
                    return value;
                })
                .finally(() => {
                    inFlight = null;
                });
            return inFlight;
        },
    };
}
