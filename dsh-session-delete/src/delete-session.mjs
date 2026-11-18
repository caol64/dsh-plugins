/**
 * One deletion run: the only place in this plugin that removes anything.
 *
 * The order is load-bearing and must not be rearranged:
 *
 * 1. **Refuse before touching anything.** An unknown session, a forbidden
 *    running session, or a stuck turn all end here with *zero* files removed.
 * 2. **Locate, then guard.** The directory comes from session persistence's own
 *    `stat().location.path`, never from joining `<root>/<cwd>/<id>` by hand, so
 *    a persistence layout change cannot aim this plugin at the wrong files. The
 *    ownership guards in `./targets.mjs` then refuse anything ambiguous.
 * 3. **Delete derived records through their owner**, then the remaining cache
 *    documents on disk. The `session_projcache` domain table is the authority:
 *    deleting the row through `storageDomain` keeps the in-memory table and the
 *    document consistent, and plain `unlink` cleans whatever the domain did not
 *    have loaded.
 * 4. **Delete the session directory.** This is the point of no return. It is a
 *    single recursive removal of a directory proved to be owned by the session.
 * 5. **Detach the row from every projection that can still name it** — workspace
 *    accounting, the archive set, the pin set — then announce
 *    `api-session/removed` so every connected browser drops the row. The client
 *    session controller already subscribes to that event; it is the official
 *    refresh, not a plugin-private channel.
 *
 * Every step after 4 is best-effort and downgraded to a warning: once the log is
 * gone the session no longer exists, and a leftover pin entry or a stale list
 * row must not turn a successful deletion into a reported failure.
 *
 * @module dsh-session-delete/delete-session
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DeleteFailure, asDeleteFailure } from "./errors.mjs";
import {
    defaultSessionRoot,
    isSessionId,
    projectionCacheLayout,
    resolveOwnedDirectory,
    selectProjectionRecords,
} from "./targets.mjs";

/** The archive/pin/accounting calls this run needs, in the order they are applied. */
const ACCOUNTING_OPERATIONS = Object.freeze(["unarchiveSession", "unpinSession"]);

/**
 * Read an optional Cordis service.
 *
 * `ctx.get(name)` is the documented accessor: it returns the service when one is
 * mounted and `undefined` otherwise, without the `inject` guard. The property
 * form (`ctx[name]`) is only a fallback, because a nested `ctx.inject([…], cb)`
 * child context serves property access for its injected dependencies alone —
 * reading `child.sessionPersistence` there is `undefined` even though the service
 * exists on the parent. (That cost one debugging round: the early version read
 * services from the inject child, so every delete answered `session-not-found`.)
 * @param {object} ctx - plugin context.
 * @param {string} key - service name.
 * @returns {unknown} the service, or undefined when absent.
 */
export function optional(ctx, key) {
    try {
        if (typeof ctx?.get === "function") {
            const service = ctx.get(key);
            if (service !== undefined) return service;
        }
    } catch {
        /* fall through to the property form */
    }
    try {
        return ctx[key];
    } catch {
        return undefined;
    }
}

/**
 * Log through the host logger when there is one.
 * @param {object} ctx - plugin context.
 * @param {'warn' | 'info'} level - log level.
 * @param {string} message - message with printf placeholders.
 * @param {...unknown} args - placeholder values.
 * @returns {void}
 */
function log(ctx, level, message, ...args) {
    const logger = optional(ctx, "logger");
    const write = logger?.[level];
    if (typeof write === "function") write.call(logger, message, ...args);
}

/**
 * The status of one live agent, when the registry has one.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @returns {string | undefined} `'running'`, `'idle'`, or undefined when cold/absent.
 */
function agentStatus(ctx, id) {
    const agents = optional(ctx, "agents");
    try {
        return agents?.get?.(id)?.status;
    } catch {
        return undefined;
    }
}

/**
 * Poll `probe` until it settles, sleeping between attempts.
 * @param {() => boolean} probe - the condition to observe.
 * @param {number} timeoutMs - total budget.
 * @param {number} [intervalMs] - delay between attempts.
 * @returns {Promise<boolean>} whether the condition became true inside the budget.
 */
async function waitUntil(probe, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (probe()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

/**
 * Stop the target's running turn, or refuse the deletion.
 *
 * A running turn is asked to cancel through the session controller (the same
 * path the composer's stop button uses) and then given a bounded window to
 * settle. An agent that will not settle is *not* deleted underneath: a live turn
 * would keep appending to a directory that no longer exists.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @param {{ allowDeleteRunning: boolean, stopTimeoutMs: number }} config - resolved config.
 * @returns {Promise<{ stopped: boolean }>} whether a running turn was cancelled and settled.
 * @throws {DeleteFailure} `agent-busy` or `agent-stuck`.
 */
async function ensureStopped(ctx, id, config) {
    if (agentStatus(ctx, id) !== "running") return { stopped: false };
    if (!config.allowDeleteRunning) throw new DeleteFailure("agent-busy", `session "${id}" is running and this profile forbids deleting running sessions`);
    const controller = optional(ctx, "sessionController");
    try {
        controller?.cancel?.({ sessionId: id });
    } catch (error) {
        log(ctx, "warn", "%s: cancelling the running turn of %s failed: %s", "session-delete", id, error?.message ?? error);
    }
    const settled = await waitUntil(() => agentStatus(ctx, id) !== "running", config.stopTimeoutMs);
    if (!settled) throw new DeleteFailure("agent-stuck", `session "${id}" did not stop within ${config.stopTimeoutMs}ms; nothing was deleted`);
    return { stopped: true };
}

/**
 * Resolve the stored session's log location, or fail as not-found.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @returns {Promise<string>} the absolute log path.
 * @throws {DeleteFailure} `session-not-found`.
 */
async function locateSession(ctx, id) {
    const persistence = optional(ctx, "sessionPersistence");
    const live = optional(ctx, "sessions")?.get?.(id);
    const snapshot = await persistence?.stat?.(id).catch((error) => {
        throw new DeleteFailure("delete-failed", `cannot stat session "${id}": ${error?.message ?? error}`);
    });
    const locationPath = snapshot?.location?.path;
    if (locationPath === undefined && live === undefined) {
        throw new DeleteFailure("session-not-found", `session "${id}" is neither live nor stored`);
    }
    if (locationPath === undefined) {
        throw new DeleteFailure(
            "denied-path",
            `session persistence reports no log path for live session "${id}"; refusing to guess one`,
        );
    }
    return locationPath;
}

/**
 * Remove the projection-cache record of a deleted session.
 *
 * The domain table delete is the authoritative step (memory and document
 * together); the filesystem sweep afterwards catches documents the domain did
 * not have loaded, including backups the cache director leaves behind.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @param {{ home: string | undefined, deleteProjectionCache: boolean, warnings: string[] }} options - runtime options.
 * @returns {Promise<void>} after the best-effort cleanup.
 */
async function dropProjectionCache(ctx, id, options) {
    if (!options.deleteProjectionCache) return;
    try {
        const domain = optional(ctx, "storageDomain")?.get?.("session_projcache");
        const table = domain?.table?.("sessions");
        if (table !== undefined) await table.delete(id);
    } catch (error) {
        options.warnings.push(`projection-cache record: ${error?.message ?? error}`);
        log(ctx, "warn", "%s: dropping the projection-cache record of %s failed: %s", "session-delete", id, error?.message ?? error);
    }
    const layout = projectionCacheLayout(options.home, id);
    if (layout === undefined) return;
    let entries;
    try {
        entries = await readdir(layout.directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code !== "ENOENT") options.warnings.push(`projection-cache documents: ${error?.message ?? error}`);
        return;
    }
    for (const target of selectProjectionRecords(layout, entries)) {
        try {
            await rm(target, { force: true });
        } catch (error) {
            options.warnings.push(`projection-cache document ${path.basename(target)}: ${error?.message ?? error}`);
        }
    }
}

/**
 * Drop the deleted id from every durable projection that can still name it.
 * Missing operations are skipped, and each failure is a warning, never an error.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @param {string[]} warnings - collector for non-fatal failures.
 * @returns {Promise<void>} after every projection was attempted.
 */
async function detachFromWorkspaces(ctx, id, warnings) {
    const registry = optional(ctx, "workspaceRegistry");
    if (registry === undefined) return;
    for (const operation of ACCOUNTING_OPERATIONS) {
        try {
            await registry[operation]?.(id);
        } catch (error) {
            warnings.push(`${operation}: ${error?.message ?? error}`);
        }
    }
    // `detachSession` is a no-op for a workspace that does not account the id,
    // and the entity's own `sessionIds` getter hides ids whose header is gone
    // (which is exactly the state after the log was removed) — so every
    // workspace is asked, and the hidden holding workspaces are covered too.
    try {
        for (const workspace of registry.list?.() ?? []) {
            await workspace.detachSession?.(id);
        }
    } catch (error) {
        warnings.push(`detachSession: ${error?.message ?? error}`);
    }
}

/**
 * Announce the removal on the API feed the client session controller listens to.
 *
 * `api-session/removed` is the official "this row left the host registry"
 * event; the controller responds by dropping the row from the sidebar. It must
 * fire *after* the files are gone so a racing list refresh cannot resurrect the
 * row.
 * @param {object} ctx - plugin context.
 * @param {string} id - session id.
 * @param {string[]} warnings - collector for non-fatal failures.
 * @returns {void}
 */
function announceRemoval(ctx, id, warnings) {
    try {
        if (typeof ctx.emit === "function") ctx.emit("api-session/removed", id);
    } catch (error) {
        warnings.push(`api-session/removed: ${error?.message ?? error}`);
    }
}

/**
 * Delete one Session permanently.
 * @param {object} ctx - host plugin context.
 * @param {{ sessionId: unknown }} request - the requested target.
 * @param {{ home?: string, sessionRoot?: string, stopTimeoutMs: number, allowDeleteRunning: boolean, deleteProjectionCache: boolean }} config - resolved config.
 * @returns {Promise<{ sessionId: string, stopped: boolean, removed: string[], warnings: string[] }>} the accepted deletion.
 * @throws {DeleteFailure} on refusal (`invalid-id`, `session-not-found`, `agent-busy`, `agent-stuck`, `denied-path`) or I/O failure.
 */
export async function deleteSession(ctx, request, config) {
    const id = request?.sessionId;
    if (!isSessionId(id)) throw new DeleteFailure("invalid-id", `not a session id: ${JSON.stringify(id)}`);

    const sessionRoot = config.sessionRoot ?? defaultSessionRoot(config.home);
    const locationPath = await locateSession(ctx, id);
    const owned = await resolveOwnedDirectory({ id, locationPath, sessionRoot });

    // Everything above is read-only. The refusal points guarantee that a
    // rejection leaves the disk exactly as it was.
    const { stopped } = await ensureStopped(ctx, id, config);

    /** @type {string[]} */
    const warnings = [];
    /** @type {string[]} */
    const removed = [];

    await dropProjectionCache(ctx, id, { ...config, home: config.home, warnings });

    try {
        await rm(owned.directory, { recursive: true, force: true });
    } catch (error) {
        throw new DeleteFailure("delete-failed", `removing "${owned.directory}" failed: ${error?.message ?? error}`, { removed });
    }
    removed.push(owned.directory);

    await detachFromWorkspaces(ctx, id, warnings);
    announceRemoval(ctx, id, warnings);

    return { sessionId: id, stopped, removed, warnings };
}

/**
 * Wrap {@link deleteSession} so every failure is a {@link DeleteFailure}, and
 * log the developer detail that must not reach the browser.
 * @param {object} ctx - host plugin context.
 * @param {{ sessionId: unknown }} request - the requested target.
 * @param {{ home?: string, sessionRoot?: string, stopTimeoutMs: number, allowDeleteRunning: boolean, deleteProjectionCache: boolean }} config - resolved config.
 * @returns {Promise<{ sessionId: string, stopped: boolean, removed: string[], warnings: string[] }>} the deletion result.
 * @throws {DeleteFailure} the normalized failure.
 */
export async function deleteSessionChecked(ctx, request, config) {
    try {
        return await deleteSession(ctx, request, config);
    } catch (error) {
        const failure = asDeleteFailure(error);
        log(ctx, "warn", "%s: deleting session %s failed (%s): %s", "session-delete", String(request?.sessionId), failure.code, failure.message);
        throw failure;
    }
}