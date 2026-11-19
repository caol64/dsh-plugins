/**
 * Browser half of dsh-zhihu-global-search: a settings page under
 * Settings → Zhihu global search whose only job is the Access Secret.
 *
 * ## Why `fetch` and not a module or an RPC bridge
 *
 * A static `dsh.client` bundle receives only the platform SEED modules. In this
 * release the table is exactly: `react`, `react/jsx-runtime`, `react-dom`,
 * `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`,
 * `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
 * `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`.
 * There is no `host`, no `styles` and no `locale` module: `locale` is a Client
 * SERVICE (`ctx.locale`, declared in `inject`), and a same-origin `fetch` to
 * the Host's exact route (`/api/dsh-zhihu-global-search/settings`) is the
 * supported bridge. Requiring any of them throws `missed the module table` and
 * the whole client half fails to activate (see `docs/DEVELOPMENT-LOG.md` §4.10).
 *
 * ## Security properties (the reason this page exists at all)
 *
 *  - the value crosses the route exactly once, in the Host direction (`save`).
 *    The Host validates it and calls `ctx.credentials.set(ref, value)`; every
 *    response — and therefore every piece of browser state and every DOM node —
 *    carries only `{ configured, source, writable }`;
 *  - the input is a password field and is cleared as soon as the write settles;
 *  - the browser never names the credential reference: the Host owns
 *    `accessSecretEnv`, so the page cannot address another plugin's secret.
 */
window.__ModuleLoader__.load({
    id: "dsh-zhihu-global-search",
    factory(require) {
        const React = require("react");
        const h = React.createElement;
        const { useState, useEffect, useRef } = React;

        const NS = "zhihu-global-search";
        /**
         * The Host's exact route, relative (no leading slash) so the request
         * follows the page's own mount; the Host registers the absolute form.
         */
        const SETTINGS_URL = "api/dsh-zhihu-global-search/settings";
        const REF_PREVIEW = "ZHIHU_ACCESS_SECRET";
        const DOCS_URL = "https://developer.zhihu.com";

        /** Locale table; zh-CN is the default language and every string lives here. */
        const TEXT = {
            "zh-CN": {
                nav: "知乎全网搜索",
                title: "知乎全网搜索",
                intro:
                    "通过知乎开放平台搜索全网内容。Access Secret 保存在 DSH 的凭据存储中（不写入任何配置文件），保存后下一次搜索立即生效。",
                secretLabel: "Access Secret",
                placeholderEmpty: "粘贴知乎 Access Secret",
                placeholderSet: "已配置；如需更换请输入新的 Access Secret",
                stateConfigured: (source) => `已配置（来源：${sourceText(source)}）`,
                stateUnconfigured: "尚未配置",
                envManaged: "该密钥由环境变量提供，在此只读；如需在此修改，请先取消环境变量后重启。",
                envName: (ref) => `环境变量名：${ref}`,
                docs: "获取 Access Secret",
                billing: "全网搜索按次计费，每日有免费额度；额度用尽后调用会失败，不会自动重试。",
                save: "保存",
                saving: "保存中…",
                remove: "移除",
                removing: "移除中…",
                saved: "已保存，下一次搜索立即生效。",
                removed: "已移除。",
                saveFailed: "保存失败：",
                removeFailed: "移除失败：",
                loadFailed: "无法读取密钥状态：",
                stateUnknown: "无法读取密钥状态，暂时不能修改。",
                empty: "请输入 Access Secret 后再保存。",
                noStore: "当前环境没有可用的凭据存储，请改用环境变量。",
                saveRejected: "凭据存储没有接受这次写入，请改用环境变量。",
                unavailable: "插件未完全加载，无法保存密钥。",
            },
            en: {
                nav: "Zhihu global search",
                title: "Zhihu global search",
                intro:
                    "Searches the whole web through the Zhihu Open Platform. The Access Secret is kept in the harness credential store (never in a configuration file) and applies to the next search.",
                secretLabel: "Access Secret",
                placeholderEmpty: "Paste your Zhihu Access Secret",
                placeholderSet: "Configured; enter a new Access Secret to replace it",
                stateConfigured: (source) => `Configured (source: ${sourceText(source)})`,
                stateUnconfigured: "Not configured",
                envManaged:
                    "This secret comes from the environment and is read-only here. To change it here, unset the environment variable and restart.",
                envName: (ref) => `Environment variable: ${ref}`,
                docs: "Get an Access Secret",
                billing:
                    "Each global search is billed per request and draws on a daily free quota; once it runs out calls fail and are not retried automatically.",
                save: "Save",
                saving: "Saving…",
                remove: "Remove",
                removing: "Removing…",
                saved: "Saved; the next search uses it immediately.",
                removed: "Removed.",
                saveFailed: "Could not save: ",
                removeFailed: "Could not remove: ",
                loadFailed: "Could not read the credential state: ",
                stateUnknown: "Could not read the credential state, so it cannot be changed right now.",
                empty: "Enter an Access Secret before saving.",
                noStore: "No credential store is available here; use an environment variable instead.",
                saveRejected: "The credential store did not accept the write; use an environment variable instead.",
                unavailable: "The plugin is not fully loaded, so the secret cannot be saved.",
            },
        };

        /** Human text for a credential source layer. */
        function sourceText(source) {
            if (!source) return "credentials";
            if (source === "env" || source === "environment") return "environment";
            return String(source);
        }

        /**
         * Read the locale service the plugin declared in `inject`.
         *
         * `locale` is a Client Cordis SERVICE (`ctx.locale`), never a module: the
         * browser module table carries only platform seeds, so requiring the
         * locale as a module throws `missed the module table` and the whole
         * client half fails to activate. A context without it (an older host)
         * degrades to zh-CN.
         * @param {object} ctx - client plugin context.
         * @returns {object | undefined} the service when present.
         */
        function localeService(ctx) {
            try {
                const service = ctx.locale;
                return typeof service?.getLocale === "function" ? service : undefined;
            } catch {
                return undefined;
            }
        }

        /**
         * Inject the page stylesheet. The host tags every `<style>` a factory adds
         * with `data-plugin`, and removes them when that entry is unloaded or
         * replaced, so this is the module-table-free way to own styles.
         * @param {string} css - the stylesheet text.
         * @returns {() => void} remover.
         */
        function insertStyles(css) {
            if (typeof document === "undefined") return () => {};
            const element = document.createElement("style");
            element.textContent = css;
            document.head.append(element);
            return () => {
                element.remove();
            };
        }

        /** The language pack for the active locale, falling back to zh-CN. */
        function pickText(locale) {
            const id = String(locale ?? "");
            if (/^zh/iu.test(id)) return TEXT["zh-CN"];
            const base = id.split("-")[0];
            return TEXT[base] ?? TEXT.en;
        }

        const CSS = `
.zgs-section { display: flex; flex-direction: column; gap: 16px; max-width: 640px; padding: 4px 0 24px; }
.zgs-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-text-primary, inherit); }
.zgs-intro { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-text-secondary, inherit); }
.zgs-card { display: flex; flex-direction: column; gap: 10px; padding: 16px;
    border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3)); border-radius: 10px;
    background: var(--dsw-alias-surface-raised, transparent); }
.zgs-row { display: flex; align-items: center; gap: 8px; }
.zgs-label { font-size: 13px; font-weight: 600; color: var(--dsw-alias-text-primary, inherit); }
.zgs-state { font-size: 12px; color: var(--dsw-alias-text-secondary, inherit); }
.zgs-form { display: flex; gap: 8px; flex-wrap: wrap; }
.zgs-input { flex: 1 1 260px; min-width: 0; height: 32px; padding: 0 10px; font-size: 13px;
    color: var(--dsw-alias-text-primary, inherit); background: var(--dsw-alias-surface-base, transparent);
    border: 1px solid var(--dsw-alias-border-default, rgba(127,127,127,.45)); border-radius: 8px; }
.zgs-input:focus-visible { outline: 2px solid var(--dsw-alias-accent-primary, #247bbf); outline-offset: 1px; }
.zgs-input:disabled { opacity: .6; cursor: not-allowed; }
.zgs-btn { height: 32px; padding: 0 14px; font-size: 13px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--dsw-alias-border-default, rgba(127,127,127,.45));
    background: var(--dsw-alias-surface-raised, transparent); color: var(--dsw-alias-text-primary, inherit); }
.zgs-btn[data-variant="primary"] { border-color: transparent;
    background: var(--dsw-alias-accent-primary, #247bbf); color: var(--dsw-alias-text-on-accent, #fff); }
.zgs-btn:disabled { opacity: .55; cursor: not-allowed; }
.zgs-btn:focus-visible { outline: 2px solid var(--dsw-alias-accent-primary, #247bbf); outline-offset: 1px; }
.zgs-hint { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-text-tertiary, var(--dsw-alias-text-secondary, inherit)); }
.zgs-link { color: var(--dsw-alias-accent-primary, #247bbf); text-decoration: none; }
.zgs-link:hover { text-decoration: underline; }
.zgs-status { font-size: 12px; line-height: 1.55; }
.zgs-status[data-tone="ok"] { color: var(--dsw-alias-feedback-success, inherit); }
.zgs-status[data-tone="error"] { color: var(--dsw-alias-feedback-danger, inherit); }
`;

        /**
         * Call one settings operation on the Host.
         *
         * The response is the credential view and nothing else: there is no path
         * by which a stored value could come back to the page.
         * @param {"settings" | "clear" | "save"} op - the operation.
         * @param {string} [value] - the Access Secret, for `save` only.
         * @returns {Promise<{ ref: string, configured: boolean, source?: string, writable: boolean, store: boolean, failed?: boolean }>} the view.
         */
        async function callSettings(op, value) {
            const response = await fetch(SETTINGS_URL, {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(op === "save" ? { op, value } : { op }),
            });
            const payload = await response.json().catch(() => ({}));
            if (response.ok !== true || payload?.ok !== true) {
                throw new Error(payload?.message ?? `HTTP ${response.status}`);
            }
            return payload;
        }

        /** Read the current credential state. */
        function loadState() {
            return callSettings("settings");
        }

        /**
         * The settings page. All text comes from the locale service; the secret
         * input is uncontrolled state that is wiped after every write.
         */
        function ZhihuSearchSettings() {
            const localeCtx = localeService(ctx);
            const [localeId, setLocaleId] = useState(() => {
                try {
                    return localeCtx?.getLocale?.().id ?? "zh-CN";
                } catch {
                    return "zh-CN";
                }
            });
            useEffect(() => {
                if (!localeCtx || typeof localeCtx.subscribe !== "function") return undefined;
                return localeCtx.subscribe(() => {
                    try {
                        setLocaleId(localeCtx.getLocale?.().id ?? "zh-CN");
                    } catch {
                        /* keep the previous locale */
                    }
                });
            }, []);

            const text = pickText(localeId);
            const [state, setState] = useState({ status: "loading" });
            const [draft, setDraft] = useState("");
            const [busy, setBusy] = useState(false);
            const [notice, setNotice] = useState(null);
            const alive = useRef(true);

            useEffect(() => {
                alive.current = true;
                let cancelled = false;
                const apply = (next) => {
                    if (!cancelled && alive.current) setState({ status: "ready", ...next });
                };
                loadState()
                    .then(apply)
                    .catch((error) =>
                        apply({ ref: REF_PREVIEW, configured: false, writable: false, error: text.loadFailed + messageOf(error) }),
                    );
                return () => {
                    cancelled = true;
                    alive.current = false;
                };
            }, []);

            const ready = state.status === "ready";
            const configured = ready && state.configured === true;
            const writable = ready && state.writable === true;
            const envManaged = configured && !writable;

            const save = async () => {
                const value = draft.trim();
                if (value === "") {
                    setNotice({ tone: "error", text: text.empty });
                    return;
                }
                if (!ready) {
                    setNotice({ tone: "error", text: text.unavailable });
                    return;
                }
                setBusy(true);
                setNotice(null);
                try {
                    let next;
                    try {
                        next = await callSettings("save", value);
                    } catch (error) {
                        // The host could not persist: show that, never the value.
                        throw new Error(messageOf(error));
                    }
                    if (!next || next.configured !== true) throw new Error(text.saveRejected);
                    if (!alive.current) return;
                    setState({ status: "ready", ...next });
                    setDraft("");
                    setNotice({ tone: "ok", text: text.saved });
                } catch (error) {
                    if (!alive.current) return;
                    // Keep the draft so the user can retry without retyping.
                    setNotice({ tone: "error", text: text.saveFailed + messageOf(error) });
                } finally {
                    if (alive.current) setBusy(false);
                }
            };

            const remove = async () => {
                setBusy(true);
                setNotice(null);
                try {
                    const next = await callSettings("clear");
                    if (!alive.current) return;
                    setState({ status: "ready", ...next });
                    setDraft("");
                    setNotice({ tone: "ok", text: text.removed });
                } catch (error) {
                    if (!alive.current) return;
                    setNotice({ tone: "error", text: text.removeFailed + messageOf(error) });
                } finally {
                    if (alive.current) setBusy(false);
                }
            };

            const failed = ready && state.failed === true;
            const stateLine = configured
                ? text.stateConfigured(state.source)
                : failed
                  ? text.stateUnknown
                  : ready
                    ? text.stateUnconfigured
                    : "";
            const hint = envManaged ? text.envManaged : ready && !failed ? text.envName(state.ref) : "";

            return h(
                "section",
                { className: "zgs-section", "aria-labelledby": "zgs-title" },
                h("h3", { className: "zgs-title", id: "zgs-title" }, text.title),
                h("p", { className: "zgs-intro" }, text.intro),
                h(
                    "div",
                    { className: "zgs-card" },
                    h(
                        "div",
                        { className: "zgs-row" },
                        h("span", { className: "zgs-label" }, text.secretLabel),
                        h(
                            "span",
                            { className: "zgs-state", "data-state": configured ? "configured" : "unconfigured" },
                            stateLine,
                        ),
                    ),
                    h(
                        "form",
                        {
                            className: "zgs-form",
                            onSubmit: (event) => {
                                event.preventDefault();
                                if (!busy && writable) save();
                            },
                        },
                        h("input", {
                            className: "zgs-input",
                            type: "password",
                            name: "zhihu-access-secret",
                            autoComplete: "new-password",
                            spellCheck: false,
                            "aria-label": text.secretLabel,
                            value: draft,
                            disabled: busy || !writable,
                            placeholder: configured ? text.placeholderSet : text.placeholderEmpty,
                            onChange: (event) => setDraft(event.currentTarget.value),
                        }),
                        h(
                            "button",
                            {
                                className: "zgs-btn",
                                type: "submit",
                                "data-variant": "primary",
                                disabled: busy || !writable || draft.trim() === "",
                            },
                            busy ? text.saving : text.save,
                        ),
                        h(
                            "button",
                            {
                                className: "zgs-btn",
                                type: "button",
                                disabled: busy || !configured || !writable,
                                onClick: () => {
                                    if (!busy) remove();
                                },
                            },
                            busy ? text.removing : text.remove,
                        ),
                    ),
                    hint ? h("p", { className: "zgs-hint" }, hint) : null,
                    ready && state.error ? h("p", { className: "zgs-status", "data-tone": "error" }, state.error) : null,
                    notice
                        ? h("p", { className: "zgs-status", role: "status", "data-tone": notice.tone }, notice.text)
                        : null,
                    h(
                        "p",
                        { className: "zgs-hint" },
                        h("a", { className: "zgs-link", href: DOCS_URL, target: "_blank", rel: "noreferrer" }, text.docs),
                    ),
                    h("p", { className: "zgs-hint" }, text.billing),
                ),
            );
        }

        /** Human text for a thrown route error without leaking a payload. */
        function messageOf(error) {
            if (error && typeof error.message === "string" && error.message !== "") return error.message;
            return String(error);
        }

        /** Dictionary registered with the locale service so the page follows the app language. */
        const DICTS = { "zh-CN": TEXT["zh-CN"], en: TEXT.en };

        return {
            inject: ["slots", "locale"],
            apply(ctx) {
                ctx.effect(() => insertStyles(CSS));
                // Visible text goes through the locale service; registering the
                // dictionaries is what makes the page follow a language switch.
                const localeCtx = localeService(ctx);
                if (localeCtx && typeof localeCtx.register === "function") {
                    ctx.effect(() => localeCtx.register(NS, DICTS));
                }
                ctx.effect(() =>
                    ctx.slots.register(
                        {
                            name: "settings.section",
                            id: NS,
                            order: 25,
                            label: () => {
                                try {
                                    const localeCtx = localeService(ctx);
                                    return pickText(localeCtx?.getLocale?.().id ?? "zh-CN").nav;
                                } catch {
                                    return TEXT["zh-CN"].nav;
                                }
                            },
                        },
                        ZhihuSearchSettings,
                    ),
                );
            },
        };
    },
});