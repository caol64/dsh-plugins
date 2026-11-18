/**
 * Host half of the settings page: the three operations the browser may drive.
 *
 * The page never receives the secret value and never names the credential
 * reference. It asks for a status view, submits a new value, or clears the
 * stored one; this module owns `accessSecretEnv` and talks to
 * `ctx.credentialsController`, whose `describe` view cannot carry a value.
 */
import { isCredentialRefName } from "./credentials.mjs";
import { redact } from "./errors.mjs";

/** Upper bound on a submitted secret; the platform issues far shorter values. */
export const MAX_SECRET_CHARS = 4096;

/**
 * @typedef {{ ref: string, configured: boolean, source?: string, writable: boolean,
 *   store: boolean, failed?: boolean }} SettingsView
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
 * @param {string} ref - reference name.
 * @param {{ configured: boolean, source?: string, writable: boolean, failed?: boolean } | undefined} info - describe result.
 * @param {boolean} store - whether a credential store is mounted.
 * @returns {SettingsView} status view.
 */
export function toSettingsView(ref, info, store) {
    return {
        ref,
        configured: info?.configured === true,
        ...(info?.source ? { source: String(info.source) } : {}),
        writable: info?.writable === true && store,
        store,
        ...(info?.failed === true ? { failed: true } : {}),
    };
}

/**
 * Create the settings operations bound to one plugin instance.
 *
 * Every operation is total: it resolves to a view or rejects with a message
 * that carries no secret (the provider's own error text is redacted against the
 * submitted value before it can reach the page).
 * @param {{ controller?: { describe: Function, set: Function, unset: Function },
 *   ref: string, logger?: { warn: Function } }} options - bound dependencies.
 * @returns {{ settings: () => Promise<SettingsView>, save: (input: unknown) => Promise<SettingsView>, clear: () => Promise<SettingsView> }} operations.
 */
export function createSettingsOperations({ controller, ref, logger }) {
    if (!isCredentialRefName(ref)) throw new Error(`不支持的凭据引用名：${JSON.stringify(ref)}`);

    const store = Boolean(controller && typeof controller.set === "function");

    /**
     * Read the current state. A describe failure is reported as
     * `{ failed: true }` — "unknown" stays distinct from "not configured", so
     * the page disables its buttons instead of claiming nothing is stored.
     * @returns {Promise<{ configured: boolean, source?: string, writable: boolean, failed?: boolean } | undefined>}
     */
    const describe = async () => {
        if (!store) return undefined;
        try {
            return await controller.describe([ref]).then((batch) => batch?.[ref]);
        } catch (error) {
            logger?.warn?.("credential describe failed: %s", error?.message ?? String(error));
            return { configured: false, writable: false, failed: true };
        }
    };

    /**
     * Run one write, then report the resulting view.
     * @param {() => Promise<void>} write - the provider write.
     * @param {string[]} secrets - values to redact from a failure message.
     * @returns {Promise<SettingsView>} the view after the write.
     */
    const write = async (operation, secrets) => {
        try {
            await operation();
        } catch (error) {
            const message = redact(error?.message ?? String(error), secrets);
            throw new Error(message === "" ? "凭据存储拒绝了这次写入。" : message);
        }
        return toSettingsView(ref, await describe(), store);
    };

    return {
        async settings() {
            return toSettingsView(ref, await describe(), store);
        },

        async save(input) {
            const value = normalizeSubmittedSecret(input);
            if (!store) throw new Error("当前环境没有可用的凭据存储，请改写环境变量 accessSecretEnv 指定的变量。");
            return write(() => controller.set(ref, value), [value]);
        },

        async clear() {
            if (!store) return toSettingsView(ref, undefined, false);
            return write(() => controller.unset(ref), []);
        },
    };
}