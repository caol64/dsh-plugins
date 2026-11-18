/**
 * Locate and version the `mdcli` executable.
 *
 * Resolution order:
 *   1. an explicit absolute or PATH name from plugin config;
 *   2. `mdcli` on PATH (with the usual user-tool directories appended);
 *   3. the well-known user-tool locations (`~/.local/bin/mdcli`).
 *
 * The result carries the parsed semantic version because option support is
 * version-gated: `--truncate` only exists in mdcli >= 0.2.4.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimum mdcli release that understands `parse --truncate [N]`. */
export const TRUNCATE_MIN_VERSION = "0.2.4";

/** Directories appended to PATH when probing, covering uv tool / pipx defaults. */
function probePath() {
    const home = homedir();
    const extras = [
        join(home, ".local", "bin"),
        join(home, ".local", "pipx", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ];
    const current = (process.env.PATH ?? "").split(":").filter(Boolean);
    return [...new Set([...current, ...extras])].join(":");
}

/** Well-known install locations probed after a PATH lookup misses. */
function fallbackCandidates() {
    const home = homedir();
    return [join(home, ".local", "bin", "mdcli"), join(home, ".local", "pipx", "bin", "mdcli")];
}

/**
 * Parse `mdcli, version X.Y.Z` (or a bare `X.Y.Z`) into numeric parts.
 * @param {string} text - `mdcli --version` output.
 * @returns {[number, number, number] | null} version triple, or null when absent.
 */
export function parseVersion(text) {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two version triples.
 * @param {[number, number, number]} a - left version.
 * @param {[number, number, number]} b - right version.
 * @returns {-1 | 0 | 1} ordering of `a` against `b`.
 */
export function compareVersions(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

/**
 * Whether a probed mdcli understands `--truncate`.
 * @param {ProbeResult} probe - result of {@link probeMdcli}.
 * @returns {boolean} true when version >= 0.2.4 (unknown versions are rejected).
 */
export function supportsTruncate(probe) {
    if (!probe?.versionParts) return false;
    return compareVersions(probe.versionParts, parseVersion(TRUNCATE_MIN_VERSION)) >= 0;
}

/**
 * @typedef {{ installed: boolean, bin: string, version: string | null,
 *   versionParts: [number, number, number] | null, error: string | null }} ProbeResult
 */

/**
 * Run one `--version` probe against a candidate binary.
 * @param {string} bin - executable name or absolute path.
 * @param {number} timeoutMs - probe timeout.
 * @returns {Promise<{ ok: boolean, stdout: string, error: string }>} probe outcome.
 */
function runVersion(bin, timeoutMs) {
    return new Promise((resolve) => {
        execFile(
            bin,
            ["--version"],
            { timeout: timeoutMs, env: { ...process.env, PATH: probePath() }, encoding: "utf8" },
            (error, stdout, stderr) => {
                if (error) {
                    resolve({ ok: false, stdout: "", error: stderr?.trim() || error.message });
                    return;
                }
                resolve({ ok: true, stdout: String(stdout), error: "" });
            },
        );
    });
}

/**
 * Probe the mdcli executable once (no caching; callers cache).
 * @param {string} [command] - configured executable; empty means auto-detect.
 * @param {number} [probeTimeoutMs] - per-candidate probe timeout.
 * @returns {Promise<ProbeResult>} what was found, where, and which version.
 */
export async function probeMdcli(command = "", probeTimeoutMs = 10_000) {
    const candidates = command ? [command] : ["mdcli", ...fallbackCandidates()];
    let lastError = null;
    for (const bin of candidates) {
        const result = await runVersion(bin, probeTimeoutMs);
        if (!result.ok) {
            lastError = result.error;
            continue;
        }
        const versionParts = parseVersion(result.stdout);
        return {
            installed: true,
            bin,
            version: versionParts ? versionParts.join(".") : null,
            versionParts,
            error: null,
        };
    }
    return {
        installed: false,
        bin: command || "mdcli",
        version: null,
        versionParts: null,
        error: lastError,
    };
}

/**
 * Small TTL cache around {@link probeMdcli}, so a session does not fork a
 * version check on every tool call while still noticing an install.
 * @param {() => Promise<ProbeResult>} loader - probe function.
 * @param {{ ttlMs?: number }} [options] - cache lifetime.
 * @returns {{ get: () => Promise<ProbeResult>, invalidate: () => void }} cached accessor.
 */
export function createProbeCache(loader, { ttlMs = 60_000 } = {}) {
    /** @type {{ at: number, value: Promise<ProbeResult> } | null} */
    let entry = null;
    return {
        get() {
            const now = Date.now();
            if (entry && now - entry.at < ttlMs) return entry.value;
            // Keep the rejected promise out of the cache so a transient failure retries.
            const value = loader().catch((error) => {
                entry = null;
                throw error;
            });
            entry = { at: now, value };
            return value;
        },
        invalidate() {
            entry = null;
        },
    };
}
