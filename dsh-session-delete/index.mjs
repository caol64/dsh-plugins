/**
 * dsh-session-delete — permanently delete a Session from the sidebar.
 *
 * The Host half owns one job: answer the browser's delete request. All
 * filesystem work lives in `./src/delete-session.mjs` and every safety guard in
 * `./src/targets.mjs`; this file resolves configuration, validates the request
 * shape, and projects the result onto the wire.
 *
 * ## Why an HTTP route and not a package RPC
 *
 * A static `dsh.client` bundle receives only the browser module seeds (`react`,
 * `@deepseek-ai/cordis`, the client slot primitives) — there is no `host`
 * module and no package-RPC bridge for it. The supported bridging mechanism for
 * a static bundle is the one the other community plugins use: the Host
 * registers an exact Fetch route below `/api` through
 * `ctx.connection.fetch.register()`, which applies the physical carrier's
 * trust and authentication policy first (only owner Peers reach the route),
 * and the browser half calls it with a same-origin `fetch`. The client module
 * therefore cannot reach any Host service directly.
 *
 * ## What it deletes, and what it deliberately leaves alone
 *
 *  - the session's own log directory (`<root>/<project>/<session-id>/`), including
 *    every format generation and the write lease file;
 *  - the session's projection-cache record (domain row + document + backups);
 *  - the session's workspace accounting, archive entry and pin entry;
 *  - NOT the content-addressed attachment store: those blobs are shared between
 *    sessions, so removing them could corrupt an unrelated one.
 *
 * The session list refreshes because the Host emits the official
 * `api-session/removed` event, which the client session controller already
 * subscribes to. No plugin-private refresh channel is involved.
 *
 * @module dsh-session-delete
 */
import { DeleteFailure, DELETE_ERROR_CODES } from "./src/errors.mjs";
import { deleteSessionChecked, optional } from "./src/delete-session.mjs";
import { HOST_TEXT, stringsFor, translate } from "./src/i18n.mjs";

/** Stable Cordis plugin name; also the client module id. */
export const name = "session-delete";

/**
 * Required services. Nothing is truly required at activation: every service
 * this plugin touches is optional on some deployment, and a missing required
 * service fails activation — which can take the whole host down. The HTTP
 * route is mounted through `ctx.inject(["connection"], …)` instead, so the
 * plugin stays loaded in a host without a web carrier.
 */
export const inject = [];

/**
 * The exact Fetch route the browser half calls.
 *
 * The path is absolute and includes the `/api` channel prefix: the connection
 * carrier validates it with `endpointFromPath("/api", path)`, which accepts
 * only paths of the form `/api/<segment>/<segment>`. A path written as
 * `/dsh-session-delete/delete` is rejected at registration ("invalid exact
 * Fetch route") and the route silently disappears.
 */
export const DELETE_ROUTE = "/api/dsh-session-delete/delete";

/** Upper bound for a request body; the request is one short JSON object. */
const MAX_BODY_BYTES = 4 * 1024;

/** Defaults for every configuration key; also the documented contract. */
export const DEFAULTS = Object.freeze({
    stopTimeoutMs: 8_000,
    allowDeleteRunning: true,
    deleteProjectionCache: true,
});

/** Exclusive upper bound for the stop budget, to keep a hung turn from stalling the RPC. */
const STOP_TIMEOUT_MAX_MS = 120_000;

/**
 * Resolve a plugin configuration fragment into validated settings.
 * @param {Record<string, unknown>} [raw] - loader-provided config.
 * @returns {{ stopTimeoutMs: number, allowDeleteRunning: boolean, deleteProjectionCache: boolean }} complete settings.
 * @throws {Error} on an unknown key or a value of the wrong type.
 */
export function resolveConfig(raw = {}) {
    const input = raw ?? {};
    for (const key of Object.keys(input)) {
        if (!(key in DEFAULTS)) throw new Error(`${name}: unknown config key "${key}"`);
    }
    const stopTimeoutMs = input.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
    if (typeof stopTimeoutMs !== "number" || !Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 0 || stopTimeoutMs > STOP_TIMEOUT_MAX_MS) {
        throw new Error(`${name}: config "stopTimeoutMs" must be a number between 0 and ${STOP_TIMEOUT_MAX_MS}`);
    }
    const booleans = {};
    for (const key of ["allowDeleteRunning", "deleteProjectionCache"]) {
        const value = input[key] ?? DEFAULTS[key];
        if (typeof value !== "boolean") throw new Error(`${name}: config "${key}" must be a boolean`);
        booleans[key] = value;
    }
    return { stopTimeoutMs, ...booleans };
}

/**
 * Read the harness home.
 *
 * The authoritative log location always comes from session persistence; the
 * home is only needed for the projection cache and as a secondary path guard.
 * `$DSH_HOME` is the same value `@deepseek-ai/dsh-home-paths` resolves from, so
 * reading it here cannot disagree with where the host stores its data. Without
 * it (an unusual embedded launch) the two home-derived steps are skipped rather
 * than guessed at `~/.dsh`, which could belong to a different installation.
 * @param {object} _ctx - plugin context (unused: no service exposes the home).
 * @returns {string | undefined} the resolved `DSH_HOME`, when present.
 */
export function harnessHome(_ctx) {
    const env = typeof process !== "undefined" ? process.env?.DSH_HOME : undefined;
    return typeof env === "string" && env.trim().length > 0 ? env.trim() : undefined;
}

/**
 * Read a bounded JSON body from a Fetch request.
 * @param {Request} request - the incoming request.
 * @returns {Promise<unknown>} the parsed body.
 * @throws {DeleteFailure} `invalid-id` for a malformed or oversized body.
 */
async function readJsonBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new DeleteFailure("invalid-id", "request body is too large");
    if (text.trim() === "") return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new DeleteFailure("invalid-id", "request body is not JSON");
    }
}

/**
 * Build a JSON response.
 * @param {unknown} body - the JSON payload.
 * @param {number} [status] - the HTTP status.
 * @returns {Response} a non-cacheable JSON response.
 */
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}

/**
 * The HTTP status that best expresses a failure code.
 * @param {string} code - the failure code.
 * @returns {number} the status.
 */
function statusFor(code) {
    switch (code) {
        case "invalid-id":
            return 400;
        case "session-not-found":
            return 404;
        case "agent-busy":
            return 409;
        case "agent-stuck":
            return 409;
        case "denied-path":
            return 403;
        default:
            return 500;
    }
}

/**
 * Handle one delete request.
 *
 * The response always carries a stable `code` on failure and never carries a
 * path, a stack, or an internal message: those are logged on the Host. A
 * successful deletion answers `{ ok: true, sessionId, stopped, removed, warnings }`.
 * @param {object} ctx - plugin context.
 * @param {{ stopTimeoutMs: number, allowDeleteRunning: boolean, deleteProjectionCache: boolean }} config - resolved config.
 * @param {Request} request - the incoming request.
 * @returns {Promise<Response>} the response.
 */
async function handleDelete(ctx, config, request) {
    const text = stringsFor(optional(ctx, "i18n")?.locale);
    try {
        const body = await readJsonBody(request);
        const record = typeof body === "object" && body !== null ? body : {};
        const runtime = { ...config, home: harnessHome(ctx) };
        if (record.stopRunning === false) runtime.allowDeleteRunning = false;
        const result = await deleteSessionChecked(ctx, { sessionId: record.sessionId }, runtime);
        return json({
            ok: true,
            sessionId: result.sessionId,
            stopped: result.stopped,
            removed: result.removed.length,
            warnings: [...result.warnings],
        });
    } catch (error) {
        const failure = error instanceof DeleteFailure ? error : new DeleteFailure("internal", error instanceof Error ? error.message : String(error));
        optional(ctx, "logger")?.warn?.("%s: delete request failed (%s): %s", name, failure.code, failure.message);
        return json({ ok: false, code: failure.code, message: translate(text, `error.${failure.code}`), removed: failure.toWire().removedCount }, statusFor(failure.code));
    }
}

/**
 * Mount the Host half.
 *
 * `ctx.inject(["connection"], …)` delays the callback until a web carrier is
 * available and unloads it when that carrier goes away, so a headless host
 * keeps the plugin loaded with no route and no failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Record<string, unknown>} [rawConfig] - loader config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    ctx.inject(["connection"], (inner) => {
        // A route the carrier refuses is a hard failure of this plugin's only
        // job, so it is NOT caught: an earlier version swallowed the error and
        // the plugin looked loaded while every delete answered 404. Letting it
        // throw fails activation visibly instead.
        //
        // The agent context always carries `effect`; a test host may not, in
        // which case the disposer returned by `register` is registered on the
        // parent context instead, so the route still unloads with it.
        if (typeof inner.effect === "function") {
            inner.effect(
                () =>
                    inner.connection.fetch.register({
                        path: DELETE_ROUTE,
                        methods: ["POST"],
                        requestBody: "buffered",
                        fetch: (request) => handleDelete(inner, config, request),
                    }),
                `${name}: delete route`,
            );
        } else {
            const dispose = inner.connection.fetch.register({
                path: DELETE_ROUTE,
                methods: ["POST"],
                requestBody: "buffered",
                fetch: (request) => handleDelete(inner, config, request),
            });
            if (typeof dispose === "function") ctx.effect?.(() => dispose);
        }
        optional(inner, "logger")?.info?.("%s: delete route mounted at %s", name, DELETE_ROUTE);
    });
}

export { DELETE_ERROR_CODES, HOST_TEXT };