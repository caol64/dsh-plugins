/**
 * The one Host route the settings page calls.
 *
 * A static `dsh.client` bundle can only reach the Host through an exact Fetch
 * route: it gets no `host` module and no package-RPC bridge (see
 * `docs/DEVELOPMENT-LOG.md` §4.10). This module owns the route's wire contract
 * — its path, request parsing, and status mapping — so `index.mjs` stays a thin
 * mount and the browser half has one documented endpoint.
 *
 * Security rules the route keeps (the reason it exists at all):
 *  - the request names an operation, never a credential reference: the Host
 *    pre-binds `accessSecretEnv`, so a page cannot address another plugin's
 *    credential;
 *  - no operation returns a secret value — only
 *    `{ ref, configured, source, writable, store, failed? }`;
 *  - a failure answers a stable `code` and a message with the submitted value
 *    redacted; nothing from the stack or the provider reaches the page.
 */
import { createSettingsOperations } from "./settings.mjs";

/**
 * The exact Fetch route. The path includes the `/api` channel prefix and is
 * validated by the carrier with `endpointFromPath("/api", path)`, which accepts
 * only `/api/<segment>/<segment>` with segments matching `[A-Za-z0-9_$.-]+`. A
 * path outside that shape is rejected at registration and silently vanishes.
 */
export const SETTINGS_ROUTE = "/api/dsh-zhihu-global-search/settings";

/** Operations the route accepts, as the `op` field of a POST body. */
export const SETTINGS_OPERATIONS = Object.freeze(["settings", "save", "clear"]);

/** Upper bound for a request body; the body is one short JSON object. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * JSON response that must never be cached.
 * @param {unknown} body - the payload.
 * @param {number} [status] - HTTP status.
 * @returns {Response} the response.
 */
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}

/**
 * Parse one request body into `{ op, value }`.
 * @param {Request} request - the incoming request.
 * @returns {Promise<{ op: string, value: unknown }>} the requested operation.
 * @throws {Error} for an oversized body, non-JSON, a non-object body, or an unknown operation.
 */
export async function parseSettingsRequest(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("request body is too large");
    let body;
    try {
        body = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
        throw new Error("request body is not JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("request body is not an object");
    // The operation is carried in the body, not the path: the carrier matches
    // exact paths only, and the path belongs to this plugin, not to a verb.
    const op = typeof body.op === "string" ? body.op : "settings";
    if (!SETTINGS_OPERATIONS.includes(op)) throw new Error(`unknown operation ${JSON.stringify(op)}`);
    return { op, value: body.value };
}

/**
 * Handle one settings request.
 * @param {{ operations: { settings: Function, save: Function, clear: Function },
 *   onWarn?: (message: string) => void }} dependencies - bound operations and a logger hook.
 * @param {Request} request - the incoming request.
 * @returns {Promise<Response>} the response.
 */
export async function handleSettingsRequest({ operations, onWarn }, request) {
    let parsed;
    try {
        parsed = await parseSettingsRequest(request);
    } catch (error) {
        return json({ ok: false, code: "bad-request", message: error.message }, 400);
    }
    try {
        const view = parsed.op === "save"
            ? await operations.save({ value: parsed.value })
            : parsed.op === "clear"
              ? await operations.clear()
              : await operations.settings();
        return json({ ok: true, ...view });
    } catch (error) {
        // The operations already redact the submitted value from their messages.
        onWarn?.(`settings ${parsed.op} failed: ${error?.message ?? String(error)}`);
        const status = parsed.op === "save" && /没有可用的凭据存储/u.test(String(error?.message)) ? 503 : 500;
        return json({ ok: false, code: "settings-failed", message: error?.message ?? String(error) }, status);
    }
}

/**
 * Create the request handler for one plugin instance.
 * @param {{ ctx: object, ref: string }} options - host context and bound reference.
 * @returns {(request: Request) => Promise<Response>} the handler.
 */
export function createSettingsRoute({ ctx, ref }) {
    const operations = createSettingsOperations({
        controller: optional(ctx, "credentialsController"),
        ref,
        logger: optional(ctx, "logger"),
    });
    const onWarn = (message) => optional(ctx, "logger")?.warn?.("zhihu-global-search: %s", message);
    return (request) => handleSettingsRequest({ operations, onWarn }, request);
}

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