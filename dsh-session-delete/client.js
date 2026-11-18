/**
 * Browser half of dsh-session-delete.
 *
 * Registers one entry into the sidebar Session menu — the official legacy
 * extension slot `sidebar.workspaces.session.menu.item` that the workspace
 * browser renders before the built-in Archive action. The entry sits at the
 * bottom of that menu (`order: 1000`), reads as a destructive action, and asks
 * for a second click before deleting anything.
 *
 * ## Why the confirmation is inside the menu
 *
 * The slot only renders while its menu is open, and the shipped UI exposes no
 * dialog service a static bundle may call. So the entry owns a two-step
 * confirmation in place: the first click arms it and swaps the label for
 * "Click again to delete"; closing the menu disarms it, because the entry
 * unmounts with the menu, and an idle entry also disarms itself after
 * `CONFIRM_WINDOW_MS`.
 *
 * On success the row reports the outcome inside the still-open menu and then
 * closes it, so the outcome is never swallowed by the dismissal. On failure the
 * menu stays open with the reason attached to the row.
 *
 * ## Why `fetch` and not a package RPC
 *
 * A static `dsh.client` bundle receives only the browser module seeds (`react`,
 * `@deepseek-ai/cordis`, the sidebar/slot primitives); it has no `host` module
 * and no package-RPC bridge. The Host half registers an authenticated exact
 * route below `/api` (`/api/dsh-session-delete/delete`) through
 * `ctx.connection.fetch.register()`, and this module calls it with a
 * same-origin `fetch`. The carrier applies its Host/Origin fence and owner-Peer
 * check before the handler runs.
 *
 * ## Why the list refreshes by itself
 *
 * The Host emits the official `api-session/removed` event after the files are
 * gone; the client session controller subscribes to it and drops the row. This
 * half performs no list mutation of its own.
 */
window.__ModuleLoader__.load({
    id: "dsh-session-delete",
    factory(require) {
        const React = require("react");
        const h = React.createElement;
        const { useState, useEffect, useRef } = React;
        const locale = require("locale");

        /** Locale namespace; also the dictionary registration key. */
        const NS = "session-delete";
        /**
         * The Host route this half calls. Relative (no leading slash) so the
         * request follows the page's own mount; the Host registers the absolute
         * form, `/api/dsh-session-delete/delete`.
         */
        const DELETE_URL = "api/dsh-session-delete/delete";
        /** How long an idle armed row stays armed, in milliseconds. */
        const CONFIRM_WINDOW_MS = 4000;
        /** How long the success line stays visible before the menu closes, in milliseconds. */
        const SUCCESS_HOLD_MS = 900;

        /** Every visible string; zh-CN is the default language. */
        const TEXT = {
            "zh-CN": {
                delete: "删除会话",
                confirm: "再次点击确认删除",
                armedTitle: "再次点击将永久删除该会话，无法恢复。",
                deleting: "正在删除…",
                deleted: "会话已删除",
                deletedStopped: "已停止运行并删除会话",
                failed: "删除失败：",
                unknownFailure: "发生意外错误，请查看宿主日志。",
                network: "无法连接宿主。",
                error: {
                    "invalid-id": "会话 ID 不合法。",
                    "session-not-found": "该会话已不存在。",
                    "agent-busy": "该会话正在运行，请先停止后再删除。",
                    "agent-stuck": "该会话没有在限定时间内停止，未删除任何文件。",
                    "denied-path": "无法确认该会话的文件归属，未删除任何文件。",
                    "delete-failed": "删除会话文件时出错，可能只删除了一部分。",
                    internal: "发生意外错误，请查看宿主日志。",
                },
            },
            en: {
                delete: "Delete session",
                confirm: "Click again to delete",
                armedTitle: "Clicking again permanently deletes this session. This cannot be undone.",
                deleting: "Deleting…",
                deleted: "Session deleted",
                deletedStopped: "Stopped the running turn and deleted the session",
                failed: "Delete failed: ",
                unknownFailure: "Unexpected error; check the host log.",
                network: "Cannot reach the host.",
                error: {
                    "invalid-id": "That is not a valid session id.",
                    "session-not-found": "That session no longer exists.",
                    "agent-busy": "That session is running; stop it before deleting.",
                    "agent-stuck": "The running turn did not stop in time; nothing was deleted.",
                    "denied-path": "Could not prove which files belong to that session; nothing was deleted.",
                    "delete-failed": "Deleting the session files failed; some files may be gone.",
                    internal: "Unexpected error; check the host log.",
                },
            },
        };

        /** Dictionaries in the shape the locale service takes. */
        const DICTS = { "zh-CN": TEXT["zh-CN"], en: TEXT.en };

        /** Locale seat passed to the row so it re-reads the active language. */
        const LocaleContext = React.createContext(undefined);

        /**
         * Pick the dictionary for a locale tag, falling back to Chinese.
         * @param {string | undefined} id - the active locale tag.
         * @returns {typeof TEXT["zh-CN"]} the dictionary.
         */
        function pickText(id) {
            return typeof id === "string" && id.toLowerCase().startsWith("en") ? TEXT.en : TEXT["zh-CN"];
        }

        /**
         * Resolve the active locale service.
         * @param {object} ctx - client plugin context.
         * @returns {object | undefined} the service when present.
         */
        function localeService(ctx) {
            try {
                const service = ctx.get("locale") ?? locale;
                return typeof service?.getLocale === "function" ? service : undefined;
            } catch {
                return undefined;
            }
        }

        /**
         * Read a locale tag without throwing.
         * @param {object | undefined} service - the locale service.
         * @returns {string} the active tag, or the default.
         */
        function localeTag(service) {
            try {
                const id = service?.getLocale?.()?.id;
                return typeof id === "string" && id.length > 0 ? id : "zh-CN";
            } catch {
                return "zh-CN";
            }
        }

        /**
         * Subscribe a component to locale changes.
         * @param {object | undefined} service - the locale service.
         * @returns {string} the current locale tag.
         */
        function useLocaleTag(service) {
            const [tag, setTag] = useState(() => localeTag(service));
            useEffect(() => {
                if (typeof service?.subscribe !== "function") return undefined;
                return service.subscribe(() => setTag(localeTag(service)));
            }, [service]);
            return tag;
        }

        /**
         * Translate one failure code, tolerating codes this build does not know.
         * @param {typeof TEXT["zh-CN"]} text - the active dictionary.
         * @param {unknown} code - the code reported by the Host.
         * @returns {string} display text.
         */
        function failureText(text, code) {
            const key = typeof code === "string" ? code : "internal";
            return text.error[key] ?? text.error.internal;
        }

        /** The row's CSS; colors are host theme tokens, the fallbacks only cover a missing token. */
        const CSS = `
.sd-row {
    display: flex; align-items: baseline; gap: 8px; width: 100%; min-height: 30px;
    padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
    font: inherit; font-size: 13px; text-align: left; cursor: pointer;
    color: var(--dsw-alias-feedback-danger, #d64545);
}
.sd-row:hover, .sd-row:focus-visible {
    background: var(--dsw-alias-surface-raised, rgba(127,127,127,.12)); outline: none;
}
.sd-row[data-armed="true"] { font-weight: 600; }
.sd-row[data-busy="true"] { cursor: progress; opacity: .75; }
.sd-row[data-done="true"] { color: var(--dsw-alias-feedback-success, inherit); }
.sd-row[data-done="true"] { cursor: default; }
.sd-row[data-busy="true"]::after {
    content: ""; align-self: center; width: 11px; height: 11px; border-radius: 50%;
    border: 1.5px solid currentColor; border-top-color: transparent;
    animation: sd-spin .7s linear infinite;
}
.sd-row__note { font-weight: 400; font-size: 12px; color: var(--dsw-alias-text-secondary, inherit); }
.sd-row[data-tone="error"] .sd-row__note { color: var(--dsw-alias-feedback-danger, #d64545); }
@keyframes sd-spin { to { transform: rotate(360deg); } }
`;

        /**
         * One Session-menu row: destructive label, two-step confirmation, and
         * the delete request. The component unmounts with the menu, which is why
         * the armed state and any in-flight request live here.
         * @param {object} props - owner share (`sessionId`, `displayTitle`) plus `useMenuOpenState`.
         * @returns {import('react').ReactElement} the menu row.
         */
        function DeleteSessionRow({ sessionId, displayTitle, useMenuOpenState }) {
            const localeCtx = React.useContext(LocaleContext);
            const tag = useLocaleTag(localeCtx);
            const text = pickText(tag);
            const [, setMenuOpen] = useMenuOpenState();
            const [phase, setPhase] = useState("idle");
            const [failure, setFailure] = useState(null);
            const timers = useRef(new Set());
            const alive = useRef(true);

            /** Schedule one callback and remember it for unmount cleanup. */
            const later = (callback, delay) => {
                const id = setTimeout(() => {
                    timers.current.delete(id);
                    if (alive.current) callback();
                }, delay);
                timers.current.add(id);
                return id;
            };

            /** Cancel every pending timer of this row. */
            const clearTimers = () => {
                for (const id of timers.current) clearTimeout(id);
                timers.current.clear();
            };

            useEffect(() => {
                alive.current = true;
                return () => {
                    alive.current = false;
                    clearTimers();
                };
            }, []);

            /**
             * Send the delete request to the Host and fold the outcome into the row.
             * @returns {Promise<void>} after the row settled.
             */
            const remove = async () => {
                setPhase("deleting");
                setFailure(null);
                let payload = {};
                let ok = false;
                try {
                    const response = await fetch(DELETE_URL, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ sessionId }),
                    });
                    payload = await response.json().catch(() => ({}));
                    ok = response.ok && payload?.ok === true;
                } catch {
                    payload = { code: "network" };
                }
                if (!alive.current) return;
                if (!ok) {
                    setPhase("idle");
                    setFailure(payload?.code === "network" ? text.network : failureText(text, payload?.code));
                    return;
                }
                setPhase("done");
                // Show the outcome inside the open menu, then dismiss it. The row
                // itself is already gone from the list (the Host emitted
                // `api-session/removed`), so this is the only confirmation surface.
                later(() => setMenuOpen(false), SUCCESS_HOLD_MS);
                void payload;
            };

            /**
             * The row's single click handler: arm, then confirm.
             * @param {import('react').MouseEvent} event - the click.
             * @returns {void}
             */
            const onClick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (phase === "deleting" || phase === "done") return;
                if (phase === "armed") {
                    clearTimers();
                    void remove();
                    return;
                }
                setFailure(null);
                setPhase("armed");
                later(() => setPhase((current) => (current === "armed" ? "idle" : current)), CONFIRM_WINDOW_MS);
            };

            const label =
                phase === "deleting"
                    ? text.deleting
                    : phase === "done"
                      ? text.deleted
                      : phase === "armed"
                        ? text.confirm
                        : text.delete;
            const note =
                phase === "done"
                    ? text.deletedStopped
                    : failure !== null
                      ? text.failed + failure
                      : null;
            const title =
                phase === "armed"
                    ? text.armedTitle
                    : displayTitle
                      ? `${text.delete}：${displayTitle}`
                      : text.delete;

            return h(
                "button",
                {
                    type: "button",
                    role: "menuitem",
                    className: "sd-row",
                    "data-armed": phase === "armed" ? "true" : "false",
                    "data-busy": phase === "deleting" ? "true" : "false",
                    "data-done": phase === "done" ? "true" : "false",
                    "data-tone": failure !== null ? "error" : undefined,
                    "aria-busy": phase === "deleting" ? "true" : "false",
                    title,
                    "aria-label": title,
                    onClick,
                },
                h("span", { className: "sd-row__label" }, label),
                note === null ? null : h("span", { className: "sd-row__note", role: failure !== null ? "alert" : "status" }, note),
            );
        }

        return {
            inject: ["slots"],
            apply(ctx) {
                const localeCtx = localeService(ctx);

                // Visible text goes through the locale service; registering both
                // dictionaries is what makes the row follow a language switch.
                if (typeof localeCtx?.register === "function") {
                    ctx.effect(() => localeCtx.register(NS, DICTS), `${NS}: locale`);
                }

                ctx.effect(
                    () =>
                        ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
                            ctx.slots.register(
                                {
                                    name: "sidebar.workspaces.session.menu.item",
                                    id: NS,
                                    order: 1000,
                                    label: () => pickText(localeTag(localeCtx)).delete,
                                },
                                function SessionDeleteMenuEntry(props) {
                                    return h(
                                        LocaleContext.Provider,
                                        { value: localeCtx },
                                        h(React.Fragment, null, h("style", { dangerouslySetInnerHTML: { __html: CSS } }), h(DeleteSessionRow, props)),
                                    );
                                },
                            ),
                        ),
                    `${NS}: session menu entry`,
                );
            },
        };
    },
});