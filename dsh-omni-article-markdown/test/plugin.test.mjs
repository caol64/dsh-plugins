import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

// The host normally provides @deepseek-ai/dsh-tools; stand it in so the plugin
// can be exercised without a full Harness installation.
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@deepseek-ai/dsh-tools") {
            return { url: "data:text/javascript,export const defineTool = (options) => options;", shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const { apply, resolveConfig } = await import("../index.mjs");
const { PARAMETERS } = await import("../src/tool.mjs");

/**
 * Minimal stand-in for a Cordis context: records registrations and warnings.
 */
function fakeContext() {
    const registered = { tools: [], skills: [], warnings: [], infos: [] };
    const ctx = {
        i18n: { locale: "zh-CN" },
        workingDirectory: {
            ensure: async () => process.cwd(),
        },
        logger: {
            info: (...args) => registered.infos.push(args.join(" ")),
            warn: (...args) => registered.warnings.push(args.join(" ")),
        },
        tools: { register: (definition) => registered.tools.push(definition) },
        effect: (fn) => fn(),
    };
    // A skill registry is present in real deployments even though this plugin
    // never uses it; exposing it proves the plugin leaves it untouched.
    ctx.skills = { register: (skill) => registered.skills.push(skill) };
    return { ctx, registered };
}

test("resolveConfig applies defaults and validates values", () => {
    assert.deepEqual(resolveConfig(), {
        command: "",
        allowInstall: true,
        installTimeoutMs: 600_000,
        timeoutMs: 120_000,
    });
    assert.equal(resolveConfig({ command: "  /usr/local/bin/mdcli  " }).command, "/usr/local/bin/mdcli");
    assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/u);
    assert.throws(() => resolveConfig({ allowInstall: "yes" }), /must be a boolean/u);
    assert.throws(() => resolveConfig({ timeoutMs: 0 }), /positive number/u);
});

test("apply registers the md_article tool and nothing else", async () => {
    const { ctx, registered } = fakeContext();
    await apply(ctx, {});

    assert.equal(registered.tools.length, 1);
    const tool = registered.tools[0];
    assert.equal(tool.name, "md_article");
    assert.equal(tool.parameters, PARAMETERS);
    assert.ok(PARAMETERS.url.required, "url must be declared required in the authoring spec");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
    assert.equal(tool.isConcurrencySafe?.(), true);
    assert.ok(typeof tool.timeoutMs === "number" && tool.timeoutMs > 0);

    // The rendered value must satisfy the declared output schema shape.
    const rendered = tool.output.render(
        { url: "u" },
        { markdown: "# M", truncated: false, mode: "markdown", warnings: [] },
    );
    assert.deepEqual(rendered, [{ type: "text", text: "# M" }]);
    const saved = tool.output.render(
        { url: "u" },
        { markdown: "", saved_path: "/x.md", truncated: true, mode: "saved", warnings: [] },
    );
    assert.match(saved[0].text, /\/x\.md.*已截断/u);

    assert.equal(registered.skills.length, 0, "the plugin must not register a skill");
    assert.equal(registered.warnings.length, 0);
});

test("apply rejects an invalid configuration", async () => {
    const { ctx } = fakeContext();
    await assert.rejects(apply(ctx, { timeoutMs: -1 }), /positive number/u);
});

test("presentCall labels the call from its arguments without throwing", () => {
    const { ctx, registered } = fakeContext();
    return apply(ctx, {}).then(() => {
        const tool = registered.tools[0];
        assert.equal(tool.presentCall({ url: "https://example.com/a/b" }).title, "墨探 · 正在转换 example.com");
        assert.match(tool.presentCall({ url: "https://example.com", save: "./out" }).title, /正在转换并保存/u);
        assert.match(tool.presentCall({ url: "https://example.com", raw_html: true }).title, /读取 HTML/u);
        // Replay of obsolete/garbage arguments must not throw.
        assert.doesNotThrow(() => tool.presentCall(null));
        assert.doesNotThrow(() => tool.presentCall({ url: 42 }));
    });
});
/**
 * A context that enforces the real Cordis rule: reading a service that is not
 * in the plugin's `inject` list throws. Plain object fakes cannot reproduce
 * this, which is how an uninjected `ctx.i18n` reached production before.
 * @param {string[]} injected - service names the plugin declared.
 * @param {Record<string, unknown>} services - available services.
 */
function guardedContext(injected, services) {
    const { ctx, registered } = fakeContext();
    return {
        registered,
        ctx: new Proxy(ctx, {
            get(target, key, receiver) {
                if (typeof key === "string" && key in services && !injected.includes(key)) {
                    throw new Error(`cannot get property "${key}" without inject`);
                }
                if (typeof key === "string" && key in services) return services[key];
                return Reflect.get(target, key, receiver);
            },
        }),
    };
}

test("apply never touches a service it did not inject", async () => {
    const { ctx, registered } = guardedContext(["tools"], {
        i18n: { locale: "zh-CN" },
        skills: { register: (skill) => registered.skills.push(skill) },
        workingDirectory: { ensure: async () => process.cwd() },
        effect: (fn) => fn(),
    });
    // Must not throw "cannot get property ... without inject".
    await apply(ctx, {});
    assert.equal(registered.tools.length, 1);
    // Optional services stay unused rather than turning into a hard requirement.
    assert.equal(registered.skills.length, 0, "a skill registry must never be touched");
});

test("apply works when optional services are missing entirely", async () => {
    const { ctx, registered } = guardedContext(["tools"], {});
    await apply(ctx, {});
    assert.equal(registered.tools.length, 1);
    assert.equal(registered.skills.length, 0);
});
