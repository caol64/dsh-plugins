/**
 * dsh-zhihu-global-search — expose the Zhihu Open Platform global search API
 * as a native DeepSeek Harness tool.
 *
 * The host half owns four jobs: hold the configuration (never a secret), build
 * the per-call secret resolver over THIS PLUGIN'S OWN store, register
 * `zhihu_global_search`, and project results for the model and the UI. The
 * settings page that writes the Access Secret lives in `./client`.
 *
 * Security contract enforced here:
 *  - configuration carries an environment-variable NAME (`accessSecretEnv`) only
 *    for the read-only fallback; a key that looks like a literal secret is
 *    rejected at activation;
 *  - the secret lives in `<DSH_HOME>/storages/dsh-zhihu-global-search/` (mode
 *    0700/0600, atomic writes), never in the machine-wide credential document;
 *  - the value is resolved per call, so a secret saved from the settings page
 *    reaches the next search without a restart;
 *  - no failure message, log line, or result carries the secret.
 *
 * The settings page (`./client`) drives three operations — `settings`, `save`,
 * `clear` — over one exact Fetch route bound in {@link apply} to the host-owned
 * reference name; the browser never names a credential and never reads a value.
 *
 * @module dsh-zhihu-global-search
 */
import { assertNoLiteralSecret, createSecretResolver, DEFAULT_SECRET_REF, isCredentialRefName } from "./src/credentials.mjs";
import { createSecretStore, harnessHome, resolveStoreDir } from "./src/secret-store.mjs";
import { ArgumentError, normalizeBaseURL } from "./src/endpoint.mjs";
import { SearchFailure, searchGlobal } from "./src/search.mjs";
import { createSettingsRoute, SETTINGS_ROUTE } from "./src/settings-route.mjs";
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
    secretStoreDir: "",
    baseURL: "https://developer.zhihu.com",
    timeoutMs: 30_000,
});

/**
 * Read an optional Cordis service.
 *
 * `ctx.get(key)` is tried FIRST: on a real Cordis context, property access to a
 * service this plugin did not inject throws "cannot get property without
 * inject", so the old `try { ctx[key] }` form always yielded undefined. That
 * silently disabled both the credential lookup used by the tool and the settings
 * route (§4.14). The property form remains a fallback for hosts without `get`.
 * @param {object} ctx - plugin context.
 * @param {string} key - service name.
 * @returns {unknown} the service, or undefined.
 */
function optional(ctx, key) {
    try {
        const viaGet = ctx.get?.(key);
        if (viaGet !== undefined) return viaGet;
    } catch {
        /* fall through */
    }
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
    // The store directory: an explicit `secretStoreDir` wins; otherwise the
    // plugin's own directory under the harness storage root.
    config.secretStoreDir =
        resolveStoreDir({ dir: config.secretStoreDir }) ??
        resolveStoreDir({ storageRoot: `${harnessHome()}/storages` }) ??
        "";
    return /** @type {{ accessSecretEnv: string, secretStoreDir: string, baseURL: string, timeoutMs: number }} */ (config);
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
 * Mount the settings route on the connection carrier.
 *
 * `ctx.inject(["connection"], …)` delays the callback until a web carrier exists
 * and unloads it when that carrier goes away, so a headless host keeps the
 * plugin loaded with no route and no failure. `connection` is therefore NOT in
 * the plugin's `inject`: a missing web carrier must not stop the search tool.
 *
 * This replaced an earlier attempt to discover a "package RPC bridge" by
 * probing context keys (`remote`, `rpc`, `hostRpc`, `packageRpc`). None of them
 * exists on this host, and the browser half's `require("host")` did not exist
 * either — the settings page never mounted. The exact Fetch route below is the
 * supported bridge for a static `dsh.client` bundle (see `docs/DEVELOPMENT-LOG.md`
 * §4.10).
 * @param {object} ctx - plugin context.
 * @param {{ store?: object, ref: string }} options - the plugin's own store and the env fallback name.
 * @returns {void}
 */
export function mountSettingsRoute(ctx, { store, ref }) {
    // A host that exposes no `inject` at all (a minimal test host, an older
    // runtime) simply has no carrier to mount on. Reading it through the guarded
    // accessor keeps a "cannot get without inject" host from failing activation.
    const cordisCtx = /** @type {{ inject?: Function } | undefined} */ (optional(ctx, "inject") === undefined
        ? undefined
        : ctx);
    if (typeof cordisCtx?.inject !== "function") return;
    cordisCtx.inject(["connection"], (inner) => {
        // A refused route means the settings page cannot work at all, so this is
        // NOT swallowed: failing activation is more honest than looking loaded
        // while every request 404s.
        const dispose = inner.connection.fetch.register({
            path: SETTINGS_ROUTE,
            methods: ["POST"],
            requestBody: "buffered",
            // The route runs against this plugin's own store, so it needs no
            // host service beyond a logger.
            fetch: createSettingsRoute({ ctx: inner, store, ref }),
        });
        if (typeof dispose === "function") optional(ctx, "effect")?.(() => () => {
            void dispose();
        });
        optional(inner, "logger")?.info?.("%s: settings route mounted at %s", name, SETTINGS_ROUTE);
    });
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
    // The plugin's own store. It needs no host service, so the settings page can
    // never be disabled by a composition that omits one (§4.14).
    const store = config.secretStoreDir === "" ? undefined : createSecretStore({ dir: config.secretStoreDir });
    const secrets = createSecretResolver({ store, ref: config.accessSecretEnv });

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

    mountSettingsRoute(ctx, { store, ref: config.accessSecretEnv });
}