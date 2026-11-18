/**
 * dsh-omni-article-markdown — expose the 墨探 (mdcli) article-to-Markdown
 * converter as a native DeepSeek Harness tool.
 *
 * The plugin owns the workflow the original prompt-only skill made the model
 * orchestrate by hand: locate or install `mdcli`, resolve paths against the
 * working directory, forward `--truncate` / `--save` / `read`, retry once on
 * transient failures, and turn stderr into actionable guidance. It registers
 * no skill: the tool declaration already carries the capability and its usage.
 *
 * @module dsh-omni-article-markdown
 */
import { convertArticle } from "./src/convert.mjs";
import { createProbeCache, probeMdcli } from "./src/env.mjs";
import { createInstallCache, installBrowser, installMdcli } from "./src/setup.mjs";
import { OUTPUT_SCHEMA, PARAMETERS, shortLabel, stringsFor } from "./src/tool.mjs";

/** Stable Cordis plugin name. */
export const name = "omni-article-markdown";

/**
 * Required services. Cordis refuses (and throws on) property access to a
 * service that was not injected, so every `ctx.<service>` this plugin reads
 * must be listed here — an omitted one fails plugin activation and, because
 * `inject` lists required services, takes the whole startup down.
 *
 * Optional services (`workingDirectory`, `i18n`, `effect`) are deliberately
 * NOT listed: listing them would make the plugin mandatory for them, and this
 * package ships to deployments that may lack them.
 */
export const inject = ["tools"];

/**
 * Read an optional Cordis service without triggering its "without inject"
 * guard. A missing service yields `undefined` so the plugin can degrade.
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

/** Defaults for every configuration key; also the documented contract. */
export const DEFAULTS = Object.freeze({
    command: "",
    allowInstall: true,
    installTimeoutMs: 600_000,
    timeoutMs: 120_000,
});

/**
 * Resolve a plugin configuration fragment into validated settings.
 * @param {Record<string, unknown>} [raw] - loader-provided config.
 * @returns {typeof DEFAULTS} complete settings.
 * @throws {Error} on an unknown key or a value of the wrong type.
 */
export function resolveConfig(raw = {}) {
    const known = new Set(Object.keys(DEFAULTS));
    for (const key of Object.keys(raw ?? {})) {
        if (!known.has(key)) {
            throw new Error(`${name}: unknown config key "${key}" (expected: ${[...known].join(", ")})`);
        }
    }
    /** @type {Record<string, unknown>} */
    const config = { ...DEFAULTS };
    for (const [key, value] of Object.entries(raw ?? {})) {
        if (value === undefined) continue;
        const fallback = DEFAULTS[key];
        if (typeof fallback === "string") {
            if (typeof value !== "string") throw new Error(`${name}: config "${key}" must be a string`);
            config[key] = value.trim();
        } else if (typeof fallback === "boolean") {
            if (typeof value !== "boolean") throw new Error(`${name}: config "${key}" must be a boolean`);
            config[key] = value;
        } else {
            if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
                throw new Error(`${name}: config "${key}" must be a positive number`);
            }
            config[key] = value;
        }
    }
    return config;
}

/**
 * Mount the `md_article` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Record<string, unknown>} [rawConfig] - loader config.
 * @returns {Promise<void>} after registration.
 */
export async function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig);
    const text = stringsFor(optional(ctx, "i18n")?.locale);

    const probe = createProbeCache(() => probeMdcli(config.command));
    const installs = createInstallCache((signal) =>
        installMdcli({
            timeoutMs: config.installTimeoutMs,
            signal,
            probe: async () => {
                probe.invalidate();
                return probe.get();
            },
            onProgress: (line) => ctx.logger.info("%s: mdcli install: %s", name, line),
        }),
    );

    const { defineTool } = await import("@deepseek-ai/dsh-tools");

    const runtime = {
        probe: () => probe.get(),
        invalidateProbe: () => probe.invalidate(),
        install: (signal) => installs.get(signal),
        installBrowser: (bin, signal) =>
            installBrowser({
                bin,
                timeoutMs: config.installTimeoutMs,
                signal,
                onProgress: (line) => ctx.logger.info("%s: chromium install: %s", name, line),
            }),
        run: (options) => import("./src/run.mjs").then(({ runMdcli }) => runMdcli(options)),
    };

    ctx.tools.register(
        defineTool({
            name: "md_article",
            description: text.description,
            parameters: PARAMETERS,
            output: {
                schema: OUTPUT_SCHEMA,
                render(_args, value) {
                    if (value.saved_path) {
                        return [{ type: "text", text: text.presentResultSaved(value.saved_path, value.truncated) }];
                    }
                    return [{ type: "text", text: value.markdown }];
                },
            },
            async execute(args, exec) {
                let cwd = process.cwd();
                const workingDirectory = optional(ctx, "workingDirectory");
                if (exec.agent && workingDirectory?.ensure) {
                    try {
                        cwd = await workingDirectory.ensure(exec.agent, exec.signal);
                    } catch (error) {
                        ctx.logger.warn(
                            "%s: working directory unavailable, using process cwd: %s",
                            name,
                            error.message,
                        );
                    }
                }
                return convertArticle(args, {
                    exec,
                    cwd,
                    runtime,
                    limits: { timeoutMs: config.timeoutMs, allowInstall: config.allowInstall },
                    text,
                });
            },
            isConcurrencySafe: () => true,
            timeoutMs: config.timeoutMs * 2 + 60_000,
            presentCall(args) {
                const target = shortLabel(String(args?.url ?? ""));
                const title =
                    args?.raw_html === true
                        ? text.presentRaw(target)
                        : typeof args?.save === "string" && args.save !== ""
                          ? text.presentSaving(target)
                          : text.presentFetching(target);
                return { card: "generic", title, kind: "fetch" };
            },
            presentResult(_args, result) {
                // Presentation may replay arbitrary logged values: never throw here.
                if (!result?.isError) return undefined;
                return { card: "generic", content: [{ type: "text", text: text.presentResultFailed }] };
            },
        }),
    );

    optional(ctx, "effect")?.(() => () => probe.invalidate());
}
