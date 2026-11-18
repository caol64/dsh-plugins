/**
 * Path derivation and safety guards for one Session's on-disk artifacts.
 *
 * Everything here is pure except {@link resolveTargets}, which performs the one
 * `realpath` call that binds a log location to the session root. The guards are
 * the reason this plugin may delete files at all: a path is deletable only when
 *
 * 1. the session id is a plain segment (`[A-Za-z0-9._-]`, no `..`, no separator),
 * 2. the resolved session directory sits strictly below the session root, and
 * 3. the directory's own name is exactly the session id.
 *
 * Together they make it impossible for a caller to aim the delete at any other
 * file, even if a future persistence layout nests sessions differently.
 *
 * @module dsh-session-delete/targets
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DeleteFailure } from "./errors.mjs";

/** Session ids are single path segments; anything else is refused before any I/O. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether `id` is a Session id this plugin will resolve on disk.
 * @param {unknown} id - candidate id.
 * @returns {boolean} true for a plain, non-traversing segment.
 */
export function isSessionId(id) {
    return typeof id === "string" && id.length <= 200 && SESSION_ID.test(id) && !id.includes("..");
}

/**
 * Whether `child` is a strict descendant of `root` after both are normalized.
 * @param {string} root - root directory.
 * @param {string} child - candidate descendant.
 * @returns {boolean} true when `child` lies strictly below `root`.
 */
export function isStrictDescendant(root, child) {
    const relative = path.relative(path.resolve(root), path.resolve(child));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The fallback session root of a harness home (`<home>/sessions`).
 * @param {string | undefined} home - the resolved `DSH_HOME`, when the host exposes it.
 * @returns {string | undefined} the conventional root, or undefined without a home.
 */
export function defaultSessionRoot(home) {
    return typeof home === "string" && path.isAbsolute(home) ? path.join(home, "sessions") : undefined;
}

/**
 * Derived artifacts of one session under a harness home: the projection-cache
 * record and the backups the cache director may leave beside it.
 *
 * These are derived data, never an authority: the cache treats a missing or
 * stale record as a longer tail replay, so deleting them can only cost time.
 * @param {string | undefined} home - the resolved `DSH_HOME`.
 * @param {string} id - the session id.
 * @returns {{ directory: string, recordPattern: RegExp } | undefined} layout description, or undefined without a home.
 */
export function projectionCacheLayout(home, id) {
    if (typeof home !== "string" || !path.isAbsolute(home)) return undefined;
    return {
        directory: path.join(home, "storages", "session_projcache", "sessions"),
        recordPattern: new RegExp(`^${escapeRegExp(id)}\\.json(?:\\..*)?$`),
    };
}

/**
 * Escape a literal for use inside a RegExp.
 * @param {string} value - literal text.
 * @returns {string} the escaped pattern source.
 */
export function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve the deletable artifacts of one stored session from its persistence
 * location, refusing anything that does not provably belong to it.
 * @param {{ id: string, locationPath: string, sessionRoot: string | undefined }} input - the session id and its log path.
 * @returns {Promise<{ directory: string, logPath: string }>} the owned directory and its log.
 * @throws {DeleteFailure} `denied-path` when the path escapes the session root or is not owned by the id.
 */
export async function resolveOwnedDirectory({ id, locationPath, sessionRoot }) {
    if (!isSessionId(id)) throw new DeleteFailure("invalid-id", `refusing to resolve a non-session id: ${JSON.stringify(id)}`);
    if (typeof locationPath !== "string" || !path.isAbsolute(locationPath)) {
        throw new DeleteFailure("denied-path", "session persistence reported no absolute log path");
    }
    const directory = path.dirname(locationPath);
    if (path.basename(directory) !== id) {
        throw new DeleteFailure("denied-path", `the log directory "${path.basename(directory)}" is not owned by session "${id}"`);
    }
    let resolvedDirectory;
    let rootReal;
    try {
        resolvedDirectory = await realpath(directory);
    } catch (error) {
        if (error?.code === "ENOENT") return { directory, logPath: locationPath };
        throw new DeleteFailure("delete-failed", `cannot resolve "${directory}": ${error?.message ?? error}`);
    }
    if (sessionRoot !== undefined) {
        try {
            rootReal = await realpath(sessionRoot);
        } catch (error) {
            if (error?.code !== "ENOENT") throw new DeleteFailure("delete-failed", `cannot resolve the session root: ${error?.message ?? error}`);
        }
    }
    const boundedBy = rootReal ?? sessionRoot;
    if (boundedBy !== undefined && !isStrictDescendant(boundedBy, resolvedDirectory)) {
        throw new DeleteFailure("denied-path", `"${resolvedDirectory}" is outside the session root "${boundedBy}"`);
    }
    return { directory: resolvedDirectory, logPath: locationPath };
}

/**
 * Find the projection-cache documents of one session.
 * @param {{ directory: string, recordPattern: RegExp }} layout - the cache layout.
 * @param {import('node:fs/promises').Dirent[]} entries - the cache directory listing.
 * @returns {string[]} absolute record paths (the record and any `.bak` siblings).
 */
export function selectProjectionRecords(layout, entries) {
    return entries
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && layout.recordPattern.test(entry.name))
        .map((entry) => path.join(layout.directory, entry.name));
}

/**
 * Measure whether an absolute path exists (a broken links counts as absent).
 * @param {string} target - absolute path.
 * @returns {Promise<boolean>} existence.
 */
export async function exists(target) {
    try {
        await stat(target);
        return true;
    } catch {
        return false;
    }
}