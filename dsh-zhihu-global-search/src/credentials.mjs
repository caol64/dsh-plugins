/**
 * Secret resolution for the Zhihu Access Secret.
 *
 * The harness rule is "configuration carries references, never values", and this
 * plugin extends it: the secret lives in THIS plugin's own store
 * (`src/secret-store.mjs`), not in the machine-wide credential document. See
 * `docs/DEVELOPMENT-LOG.md` §4.14 for why.
 *
 * Resolution order, per call (never cached, so a save reaches the next search):
 *  1. the plugin's own store — writable, the only thing the settings page edits;
 *  2. the environment variable named by `accessSecretEnv` — read-only fallback
 *     for CI and one-off runs.
 *
 * Nothing here puts the value into a returned view, a log line, or an error
 * message: callers receive the secret only to build a request header.
 */

/** Default reference name of the environment fallback. */
export const DEFAULT_SECRET_REF = "ZHIHU_ACCESS_SECRET";

/** A POSIX shell identifier. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Whether a string can name an environment variable.
 * @param {string} value - candidate.
 * @returns {boolean} true when the name is a POSIX identifier.
 */
export function isCredentialRefName(value) {
    return typeof value === "string" && REF_PATTERN.test(value);
}

/**
 * Reject configuration that would place a literal secret in the patch file.
 * @param {Record<string, unknown>} raw - loader config.
 * @param {string[]} allowed - known keys.
 * @throws {Error} naming the offending key and the supported alternatives.
 */
export function assertNoLiteralSecret(raw, allowed) {
    for (const key of Object.keys(raw ?? {})) {
        if (allowed.includes(key)) continue;
        if (/secret|token|api.?key|password/iu.test(key)) {
            throw new Error(
                `zhihu-global-search: config "${key}" is not supported — secrets never go in configuration. ` +
                    "Open Settings → Zhihu global search and save the Access Secret there (it is stored in this " +
                    "plugin's own store), or export the environment variable named by accessSecretEnv.",
            );
        }
        throw new Error(`zhihu-global-search: unknown config key "${key}" (expected: ${allowed.join(", ")})`);
    }
}

/**
 * Read the process environment as the fallback layer.
 * @param {string} ref - variable name.
 * @returns {string | undefined} the value when non-empty.
 */
export function fromEnvironment(ref) {
    const value = process.env[ref];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Build the per-call secret resolver used by the search pipeline.
 * @param {{ store?: { read: () => Promise<string | undefined> } | undefined,
 *   ref: string }} options - the plugin's own store (optional) and the env fallback name.
 * @returns {{ resolve: () => Promise<{ value: string, source: string } | undefined> }} resolver.
 */
export function createSecretResolver({ store, ref }) {
    return {
        async resolve() {
            if (store && typeof store.read === "function") {
                try {
                    const stored = await store.read();
                    if (typeof stored === "string" && stored.trim() !== "") {
                        return { value: stored.trim(), source: "plugin" };
                    }
                } catch (error) {
                    // A broken store must not be silently skipped: the user would
                    // otherwise see "not configured" while a secret file exists.
                    throw new Error(
                        `读取插件存储失败：${error?.message ?? String(error)}。` +
                            "请检查 Settings → 知乎全网搜索 的提示，修复或删除该存储文件后重试。",
                    );
                }
            }
            const ambient = fromEnvironment(ref);
            return ambient === undefined ? undefined : { value: ambient, source: "env" };
        },
    };
}