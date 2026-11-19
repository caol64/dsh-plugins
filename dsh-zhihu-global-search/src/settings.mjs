/**
 * Host half of the settings page: the three operations the browser may drive.
 *
 * The page never receives the secret value. It asks for a status view, submits a
 * new value, or clears the stored one. The value lives in THIS plugin's own
 * store (`src/secret-store.mjs`), so the settings operations need no host
 * service at all: they cannot be disabled by which row a composition happens to
 * mount, which is what made earlier versions report "no store" (§4.13, §4.14).
 *
 * The environment variable remains a READ-ONLY fallback: when the store is empty
 * and `ZHIHU_ACCESS_SECRET` is set, the page reports that source and disables
 * saving until the store is writable, because a stored value would shadow it.
 */
import { isCredentialRefName } from "./credentials.mjs";
import { redact } from "./errors.mjs";

/** Upper bound on a submitted secret; the platform issues far shorter values. */
export const MAX_SECRET_CHARS = 4096;

/**
 * @typedef {{ ref: string, configured: boolean, source?: string, writable: boolean,
 *   store: string | false, location?: string, failed?: boolean }} SettingsView
 */

/**
 * Normalize a submitted value.
 * @param {unknown} input - `{ value }` from the browser.
 * @returns {string} the trimmed value.
 * @throws {Error} when the value is blank, not a string, or oversized.
 */
export function normalizeSubmittedSecret(input) {
    const value = input && typeof input === "object" ? input.value : undefined;
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error("Access Secret 不能为空。");
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_SECRET_CHARS) throw new Error(`Access Secret 过长（上限 ${MAX_SECRET_CHARS} 字符）。`);
    if (/[\r\n]/u.test(trimmed)) throw new Error("Access Secret 不能包含换行符。");
    return trimmed;
}

/**
 * Build the view returned to the browser: never a value.
 * @param {string} ref - the environment fallback name.
 * @param {{ configured: boolean, source?: string, writable: boolean, failed?: boolean } | undefined} info - store status.
 * @param {string | false} store - `"plugin"` when the store answers, false otherwise.
 * @param {string} [location] - the store directory, for the page's diagnostics.
 * @returns {SettingsView} status view.
 */
export function toSettingsView(ref, info, store, location) {
    return {
        ref,
        configured: info?.configured === true,
        ...(info?.source ? { source: String(info.source) } : {}),
        writable: info?.writable === true,
        store,
        ...(typeof location === "string" && location !== "" ? { location } : {}),
        ...(info?.failed === true ? { failed: true } : {}),
    };
}

/**
 * Create the settings operations bound to one plugin instance.
 *
 * Every operation is total: it resolves to a view or rejects with a message that
 * carries no secret (the store's own error text is redacted against the
 * submitted value before it can reach the page).
 * @param {{ store: { describe: Function, write: Function, clear: Function, directory: string } | undefined,
 *   ref: string, env?: Record<string, string | undefined>, logger?: { warn: Function } }} options -
 *   the plugin's own store, the env fallback name, and an environment to read.
 * @returns {{ settings: () => Promise<SettingsView>, save: (input: unknown) => Promise<SettingsView>, clear: () => Promise<SettingsView> }} operations.
 */
export function createSettingsOperations({ store, ref, env = process.env, logger }) {
    if (!isCredentialRefName(ref)) throw new Error(`不支持的环境变量名：${JSON.stringify(ref)}`);

    /** The fallback value from the environment, when set. */
    const ambient = () => {
        const value = env?.[ref];
        return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };

    /**
     * Current status, combining the store with the environment fallback.
     * @returns {Promise<SettingsView>} the view.
     */
    const view = async () => {
        if (!store) {
            return toSettingsView(ref, { configured: ambient() !== undefined, source: "env", writable: false }, false);
        }
        const info = await store.describe();
        if (info.configured) return toSettingsView(ref, info, "plugin", store.directory);
        const fallback = ambient();
        if (fallback !== undefined) {
            // The environment provides the value, but the store stays writable:
            // saving one here is what the user came to do, and it takes over.
            return toSettingsView(ref, { configured: true, source: "env", writable: true }, "plugin", store.directory);
        }
        return toSettingsView(ref, info, "plugin", store.directory);
    };

    return {
        settings: view,

        async save(input) {
            const value = normalizeSubmittedSecret(input);
            if (!store) throw new Error("当前环境没有可用的插件存储，只能用 accessSecretEnv 指定的环境变量提供密钥。");
            try {
                await store.write(value);
            } catch (error) {
                const message = redact(error?.message ?? String(error), [value]);
                logger?.warn?.("zhihu-global-search: saving the secret failed: %s", message);
                throw new Error(message === "" ? "写入插件存储失败。" : message);
            }
            return view();
        },

        async clear() {
            if (!store) throw new Error("当前环境没有可用的插件存储。");
            try {
                await store.clear();
            } catch (error) {
                const message = error?.message ?? String(error);
                logger?.warn?.("zhihu-global-search: clearing the secret failed: %s", message);
                throw new Error(message === "" ? "移除插件存储中的密钥失败。" : message);
            }
            return view();
        },
    };
}