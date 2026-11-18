/**
 * Secret resolution for the Zhihu Access Secret.
 *
 * The harness rule is "configuration carries references, never values". This
 * module enforces it for this plugin:
 *  - the only configuration key is `accessSecretEnv`, a POSIX reference name;
 *  - the value is resolved through `ctx.credentials` (provider-managed store,
 *    then ambient fallbacks such as the process environment) on EVERY call, so
 *    a secret saved from the settings page reaches the next search without a
 *    restart;
 *  - when no credential service is mounted, the process environment is read
 *    directly, which is the same fallback the service documents.
 *
 * Nothing in this module puts the value into a returned object, a log line, or
 * an error message: callers receive the secret only to build a request header.
 */

/** Default reference name; the settings page writes to this name. */
export const DEFAULT_SECRET_REF = "ZHIHU_ACCESS_SECRET";

/** A POSIX shell identifier, the grammar of a credential reference. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Whether a string can name a credential reference.
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
                    "Open Settings → Zhihu global search and save the Access Secret there (it is stored in the " +
                    "harness credential store), or export the environment variable named by accessSecretEnv.",
            );
        }
        throw new Error(`zhihu-global-search: unknown config key "${key}" (expected: ${allowed.join(", ")})`);
    }
}

/**
 * Read the process environment as the ambient fallback layer.
 * @param {string} ref - reference name.
 * @returns {string | undefined} the value when non-empty.
 */
export function fromEnvironment(ref) {
    const value = process.env[ref];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Build the per-call secret resolver used by the search pipeline.
 * @param {{ credentials?: { resolve: (ref: string) => Promise<{ value: string, source: string } | undefined> } | undefined,
 *   ref: string }} options - credential service (optional) and reference name.
 * @returns {{ resolve: () => Promise<{ value: string, source: string } | undefined> }} resolver.
 */
export function createSecretResolver({ credentials, ref }) {
    return {
        async resolve() {
            if (credentials && typeof credentials.resolve === "function") {
                try {
                    const hit = await credentials.resolve(ref);
                    if (hit && typeof hit.value === "string" && hit.value.trim() !== "") {
                        return { value: hit.value.trim(), source: hit.source ?? "credentials" };
                    }
                } catch {
                    // A provider failure must not take the tool down; fall through
                    // to the ambient layer, exactly like a missing reference.
                }
            }
            const ambient = fromEnvironment(ref);
            return ambient === undefined ? undefined : { value: ambient, source: "env" };
        },
    };
}