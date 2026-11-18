/**
 * Stable failure vocabulary for session deletion.
 *
 * Every failure the delete path can report is one of these codes. The client
 * half maps a code to a localized sentence; the Host never builds user-facing
 * prose from an arbitrary error message, so an upstream fault can never leak a
 * path, a stack, or an internal identifier into the browser.
 *
 * @module dsh-session-delete/errors
 */

/**
 * The reason a delete request was refused or failed.
 *
 * - `invalid-id` — the requested id is not a Session id this plugin will touch.
 * - `session-not-found` — neither the live store nor session persistence holds it.
 * - `agent-busy` — the Session is running and this profile forbids deleting it.
 * - `agent-stuck` — the running turn did not stop inside the configured budget.
 * - `denied-path` — a file the delete would remove is outside the session root,
 *   or is not provably owned by this session. Nothing was removed.
 * - `delete-failed` — the filesystem or a storage call failed after removal began.
 * - `internal` — an unexpected fault; the detail is logged, not returned.
 */
export const DELETE_ERROR_CODES = Object.freeze([
    "invalid-id",
    "session-not-found",
    "agent-busy",
    "agent-stuck",
    "denied-path",
    "delete-failed",
    "internal",
]);

const CODES = new Set(DELETE_ERROR_CODES);

/**
 * A deletion failure carrying a stable code and the subset of work that
 * already completed, so the caller can report partial success honestly.
 */
export class DeleteFailure extends Error {
    /**
     * @param {string} code - one of {@link DELETE_ERROR_CODES}.
     * @param {string} message - developer-facing detail (logged, never shown as-is).
     * @param {{ removed?: readonly string[] }} [details] - work already completed.
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = "DeleteFailure";
        this.code = CODES.has(code) ? code : "internal";
        /** @type {readonly string[]} absolute paths already removed */
        this.removed = Object.freeze([...(details.removed ?? [])]);
    }

    /**
     * Project the failure onto the wire: the code plus machine-safe counts.
     * @returns {{ code: string, removedCount: number }} a JSON-safe projection.
     */
    toWire() {
        return { code: this.code, removedCount: this.removed.length };
    }
}

/**
 * Coerce any thrown value into a {@link DeleteFailure}.
 * @param {unknown} error - whatever the failing step threw.
 * @returns {DeleteFailure} the code-carrying failure.
 */
export function asDeleteFailure(error) {
    if (error instanceof DeleteFailure) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new DeleteFailure("internal", message);
}