/**
 * dsh-zhihu-global-search — expose the Zhihu Open Platform global search API
 * as a native DeepSeek Harness tool.
 *
 * The host half owns four jobs: hold the configuration (never a secret), build
 * the per-call secret resolver over `ctx.credentials`, register
 * `zhihu_global_search`, and project results for the model and the UI. The
 * settings page that writes the Access Secret lives in `./client`.
 *
 * Security contract enforced here:
 *  - configuration carries a credential REFERENCE (`accessSecretEnv`) only; a
 *    key that looks like a literal secret is rejected at activation;
 *  - the value is resolved per call, so a secret saved from the settings page
 *    reaches the next search without a restart;
 *  - no failure message, log line, or result carries the secret.
 *
 * The settings page (`./client`) drives three operations over the package RPC —
 * `settings`, `save`, `clear` — bound in {@link apply} to the host-owned
 * reference name; the browser never names a credential and never reads a value.
 *
 * @module dsh-zhihu-global-search
 */
import { assertNoLiteralSecret, createSecretResolver, DEFAULT_SECRET_REF, isCredentialRefName } from "./src/credentials.mjs";
import { ArgumentError, normalizeBaseURL } from "./src/endpoint.mjs";
import { SearchFailure, searchGlobal } from "./src/search.mjs";
import { createSettingsOperations } from "./src/settings.mjs";
import {
    maxCharsOf,
    OUTPUT_SCHEMA,
    PARAMETERS,
    presentationMeta,
    renderOutput,
    shortQuery,
    stringsFor,
} from "./src/tool.mjs";

/** Stable Cordis plugin name; also the settings-page id of the client half. */
export const name = "zhihu-global-search";

/**
 * Required services. Cordis throws on property access to a service that was not
 * injected, and a throw during activation fails the plugin — so only `tools`
 * is listed. `credentials`, `credentialsController`, `i18n` and `effect` are
 * optional and read through {@link optional}.
 */
export const inject = ["tools"];

/** Defaults for every configuration key; also the documented contract. */
export const DEFAULTS = Object.freeze({
    accessSecretEnv: DEFAULT_SECRET_REF,
    baseURL: "https://developer.zhihu.com",
    timeoutMs: 30_000,
});

/**
 * Read an optional Cordis service without triggering its "without inject" guard.
 * @param {object} ctx - plugin context.
 * @param {string} key - service name.
 * @returns {unknown} the service, or undefined.
 */
function optional(ctx, key) {
    try {
        return ctx[key];
    } catch {
        return undefined;
    }
}

/**
 * Resolve a plugin configuration fragment into validated settings.
 * @param {Record<string, unknown>} [raw] - loader-provided config.
 * @returns {{ accessSecretEnv: string, baseURL: string, timeoutMs: number }} complete settings.
 * @throws {Error} on a literal-secret key, an unknown key, a bad reference name, or a bad value.
 */
export function resolveConfig(raw = {}) {
    const known = Object.keys(DEFAULTS);
    assertNoLiteralSecret(raw ?? {}, known);
    /** @type {Record<string, unknown>} */
    const config = { ...DEFAULTS };
    for (const [key, value] of Object.entries(raw ?? {})) {
        if (value === undefined) continue;
        const fallback = DEFAULTS[key];
        if (typeof fallback === "string") {
            if (typeof value !== "string") throw new Error(`${name}: config "${key}" must be a string`);
            config[key] = value.trim();
        } else {
            if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
                throw new Error(`${name}: config "${key}" must be a positive number`);
            }
            config[key] = value;
        }
    }
    if (!isCredentialRefName(config.accessSecretEnv)) {
        throw new Error(
            `${name}: config "accessSecretEnv" must be a POSIX identifier such as ${DEFAULT_SECRET_REF} ` +
                `(got ${JSON.stringify(config.accessSecretEnv)}).`,
        );
    }
    try {
        config.baseURL = normalizeBaseURL(config.baseURL);
    } catch (error) {
        throw new Error(`${name}: config "baseURL": ${error.message}`);
    }
    return /** @type {{ accessSecretEnv: string, baseURL: string, timeoutMs: number }} */ (config);
}

/**
 * The call view shown while a search runs.
 * @param {import("./src/tool.mjs").Strings} text - text table.
 * @param {unknown} args - tool arguments.
 * @returns {{ card: "generic", kind: "search", title: string }} call view.
 */
function callView(text, args) {
    return { card: "generic", kind: "search", title: text.presentSearching(shortQuery(args?.query)) };
}

/**
 * Methods the settings page may call over the package RPC.
 *
 * The Host pre-binds them to its own `accessSecretEnv`: `settings` takes no
 * arguments and the two writes take a bare string, so a request can neither
 * name another plugin's credential reference nor read a stored value back.
 */
const RPC_METHODS = Object.freeze(["settings", "save", "clear"]);

/**
 * Build the argument-free handlers over one settings-operations instance.
 * @param {ReturnType<typeof createSettingsOperations>} operations - bound operations.
 * @returns {Record<string, () => Promise<object>>} handlers.
 */
export function rpcHandlers(operations) {
    return {
        settings: () => operations.settings(),
        save: (value) => operations.save({ value }),
        clear: () => operations.clear(),
    };
}

/**
 * Mount the settings handlers on whichever package-RPC bridge this context
 * exposes.
 *
 * The bridge is host infrastructure outside this plugin's required services, so
 * it is discovered defensively among the documented shapes (`method(name, fn)`
 * or `register(table)`); a host that offers none simply has no settings page.
 * @param {object} ctx - plugin context.
 * @param {string} ref - host-owned credential reference.
 * @returns {boolean} whether a handler was mounted.
 */
export function mountSettingsRpc(ctx, ref) {
    const operations = createSettingsOperations({
        controller: optional(ctx, "credentialsController"),
        ref,
        logger: optional(ctx, "logger"),
    });
    const handlers = rpcHandlers(operations);
    let mounted = false;
    for (const key of ["remote", "rpc", "hostRpc", "packageRpc"]) {
        const service = optional(ctx, key);
        if (!service || typeof service !== "object") continue;
        try {
            if (typeof service.register === "function") {
                const dispose = service.register(handlers);
                if (typeof dispose === "function") optional(ctx, "effect")?.(() => dispose);
                mounted = true;
            } else if (typeof service.method === "function") {
                for (const method of RPC_METHODS) service.method(method, handlers[method]);
                mounted = true;
            }
        } catch (error) {
            optional(ctx, "logger")?.warn?.("%s: RPC bridge %s refused the registration: %s", name, key, error.message);
        }
    }
    if (!mounted) {
        optional(ctx, "logger")?.info?.(
            "%s: no package RPC bridge on this host; the settings page stays unavailable.",
            name,
        );
    }
    return mounted;
}

/**
 * Fold one execution into the canonical failure content.
 * Argument problems are reported as-is; everything else is already actionable.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {import("./src/tool.mjs").Strings} text - text table.
 * @param {number} maxChars - text budget.
 * @param {unknown} ctx - host context (for logging).
 * @returns {(error: unknown) => Promise<never>} a rejecting handler.
 */
function failureHandler(args, text, maxChars, ctx) {
    return async (error) => {
        if (error instanceof ArgumentError) throw error;
        if (error instanceof SearchFailure) {
            optional(ctx, "logger")?.warn?.("%s: %s", name, error.message);
            throw error;
        }
        if (error?.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : String(error);
        optional(ctx, "logger")?.warn?.("%s: unexpected failure: %s", name, message);
        throw new Error(`${text.presentResultFailed}：${message}`);
    };
}

/**
 * Mount the `zhihu_global_search` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Record<string, unknown>} [rawConfig] - loader config.
 * @returns {Promise<void>} after registration.
 */
export async function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    const text = stringsFor(optional(ctx, "i18n")?.locale);
    const secrets = createSecretResolver({ credentials: optional(ctx, "credentials"), ref: config.accessSecretEnv });

    const { defineTool } = await import("@deepseek-ai/dsh-tools");

    const registered = ctx.tools.register(
        defineTool({
            name: "zhihu_global_search",
            description: text.description,
            parameters: PARAMETERS,
            output: {
                schema: OUTPUT_SCHEMA,
                render: renderOutput,
                presentationMeta,
            },
            async execute(args, exec) {
                const maxChars = maxCharsOf(args);
                return searchGlobal(args, {
                    config,
                    ref: config.accessSecretEnv,
                    resolveSecret: () => secrets.resolve(),
                    signal: exec?.signal,
                    maxChars,
                }).catch(failureHandler(args, text, maxChars, ctx));
            },
            isConcurrencySafe: () => true,
            timeoutMs: config.timeoutMs * 2 + 30_000,
            presentCall(args) {
                return callView(text, args);
            },
            presentResult(_args, result) {
                // Presentation may replay arbitrary logged values: never throw here.
                if (!result?.isError) return undefined;
                return { card: "generic", content: [{ type: "text", text: text.presentResultFailed }] };
            },
        }),
    );

    optional(ctx, "effect")?.(() => () => {
        if (typeof registered === "function") registered();
    });

    mountSettingsRpc(ctx, config.accessSecretEnv);
}