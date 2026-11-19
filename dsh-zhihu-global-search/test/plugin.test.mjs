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

const { apply, DEFAULTS, inject, mountSettingsRoute, name, resolveConfig } = await import("../index.mjs");
const { SETTINGS_ROUTE } = await import("../src/settings-route.mjs");

/**
 * Minimal stand-in for a Cordis context that reproduces the real activation
 * rule: reading a service that was neither injected nor provided throws.
 * @param {{ inject?: string[], services?: Record<string, unknown> }} [options] - context shape.
 */
function fakeContext(options = {}) {
    const injected = new Set(options.inject ?? ["tools"]);
    const services = {
        tools: { register: (definition) => record.tools.push(definition) },
        i18n: { locale: "zh-CN" },
        ...options.services,
    };
    const record = { tools: [], registered: [], warnings: [], infos: [], effects: [], injectedDeps: [], pendingDeps: [] };
    const base = {
        logger: {
            info: (...args) => record.infos.push(args.join(" ")),
            warn: (...args) => record.warnings.push(args.join(" ")),
        },
        effect: (fn) => {
            const dispose = fn();
            record.effects.push(dispose);
            return () => (typeof dispose === "function" ? dispose() : undefined);
        },
        /**
         * Cordis `ctx.inject(deps, cb)`: waits for every dep, then runs the
         * callback with a child that reads exactly those deps. An absent dep
         * leaves the callback pending, which is the behavior under test.
         */
        inject: (deps, callback) => {
            record.injectedDeps.push([...deps]);
            if (!deps.every((key) => services[key] !== undefined)) {
                record.pendingDeps.push([...deps]);
                return undefined;
            }
            return callback(makeContext({ ...base, ...Object.fromEntries(deps.map((key) => [key, services[key]])) }, new Set([...injected, ...deps])));
        },
    };
    return { ctx: makeContext(base, injected), record };

    /**
     * @param {object} own - properties that exist on this context.
     * @param {Set<string>} visible - service names readable as plain properties.
     */
    function makeContext(own, visible) {
        return new Proxy(own, {
            get(object, property) {
                if (property in object) return object[property];
                if (typeof property !== "string") return undefined;
                // `ctx.get(name)`: the guarded lookup, answers for any mounted service.
                if (property === "get") return (key) => services[key];
                // Plain property access needs an injection, like Cordis.
                if (visible.has(property)) return services[property];
                throw new Error(`cannot get property "${property}" without inject`);
            },
            has(object, property) {
                return property in object || visible.has(property);
            },
        });
    }
}

test("inject lists only the required service", () => {
    assert.deepEqual(inject, ["tools"]);
});

test("resolveConfig applies defaults and validates every value", () => {
    assert.deepEqual(resolveConfig(), {
        accessSecretEnv: "ZHIHU_ACCESS_SECRET",
        baseURL: "https://developer.zhihu.com",
        timeoutMs: 30_000,
    });
    assert.equal(resolveConfig({ accessSecretEnv: " ZHIHU_TEAM " }).accessSecretEnv, "ZHIHU_TEAM");
    assert.equal(resolveConfig({ baseURL: "https://gw.example.com/" }).baseURL, "https://gw.example.com");
    assert.equal(resolveConfig({ timeoutMs: 5_000 }).timeoutMs, 5_000);

    assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/u);
    assert.throws(() => resolveConfig({ accessSecretEnv: "has-dash" }), /must be a POSIX identifier/u);
    assert.throws(() => resolveConfig({ baseURL: "ftp://x" }), /只支持 http\/https/u);
    assert.throws(() => resolveConfig({ timeoutMs: 0 }), /positive number/u);
    assert.throws(() => resolveConfig({ timeoutMs: "10" }), /positive number/u);
});

test("a literal secret in configuration is refused at activation, never stored", () => {
    for (const key of ["accessSecret", "apiKey", "token"]) {
        assert.throws(() => resolveConfig({ [key]: "abc" }), /secrets never go in configuration/u, key);
    }
});

test("apply registers exactly one tool and nothing else", async () => {
    const { ctx, record } = fakeContext();
    await apply(ctx, {});

    assert.equal(record.tools.length, 1);
    const tool = record.tools[0];
    assert.equal(tool.name, "zhihu_global_search");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
    assert.equal(typeof tool.output.presentationMeta, "function");
    assert.equal(tool.isConcurrencySafe(), true);
    assert.ok(tool.timeoutMs > 30_000);
    assert.match(tool.description, /Zhihu Open Platform/u);
});

test("apply survives a context that lacks every optional service", async () => {
    // Only `tools` is injected: i18n, credentials, credentialsController,
    // logger and effect are all absent, and reading them must not throw.
    const tools = { register: () => () => {} };
    const ctx = new Proxy(
        { tools },
        {
            get(object, property) {
                if (property in object) return object[property];
                throw new Error(`cannot get property "${String(property)}" without inject`);
            },
        },
    );
    await assert.doesNotReject(apply(ctx, {}));
});

test("execution without a secret reports the settings page and never calls the network", async () => {
    const { ctx, record } = fakeContext();
    await apply(ctx, {});
    const tool = record.tools[0];
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        throw new Error("must not be called");
    };
    try {
        await assert.rejects(
            tool.execute({ query: "知乎" }, { signal: new AbortController().signal }),
            /尚未配置知乎 Access Secret/u,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(called, false);
});

test("a configured secret from the credential service reaches the request", async () => {
    const calls = [];
    const { ctx, record } = fakeContext({
        // The plugin reads `credentials` through the optional guard on its OWN
        // context, so it must be injected here (as the real profile does).
        inject: ["tools", "credentials"],
        services: {
            credentials: {
                resolve: async (ref) => (ref === "ZHIHU_ACCESS_SECRET" ? { value: "s3cret", source: "credentials" } : undefined),
            },
        },
    });
    await apply(ctx, {});
    const tool = record.tools[0];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ Code: 0, Data: { Items: [] } }) };
    };
    try {
        const output = await tool.execute({ query: "知乎" }, { signal: new AbortController().signal });
        assert.equal(output.query, "知乎");
        // An empty container is a genuine empty result, not an unknown shape.
        assert.deepEqual(output.items, []);
        assert.deepEqual(output.warnings, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, "Bearer s3cret");
    assert.match(calls[0].url, /\/api\/v1\/content\/global_search\?Query=/u);
});

test("presentCall and presentResult never throw and never leak a payload", async () => {
    const { ctx, record } = fakeContext();
    await apply(ctx, {});
    const tool = record.tools[0];
    assert.deepEqual(tool.presentCall({ query: "知乎 搜索" }), {
        card: "generic",
        kind: "search",
        title: "Zhihu global search · 知乎 搜索",
    });
    assert.doesNotThrow(() => tool.presentCall(undefined));
    assert.equal(tool.presentResult({}, { isError: false }), undefined);
    const failed = tool.presentResult({}, { isError: true, error: { message: "s3cret" } });
    assert.equal(JSON.stringify(failed).includes("s3cret"), false);
});

test("unloading the plugin disposes the tool registration", async () => {
    let disposed = false;
    const { ctx, record } = fakeContext({
        services: { tools: { register: () => () => (disposed = true) } },
    });
    await apply(ctx, {});
    assert.equal(disposed, false);
    for (const cleanup of record.effects) if (typeof cleanup === "function") cleanup();
    assert.equal(disposed, true);
    assert.equal(name, "zhihu-global-search");
    assert.equal(DEFAULTS.accessSecretEnv, "ZHIHU_ACCESS_SECRET");
});

test("the settings route is mounted on the connection carrier with the bound reference", async () => {
    const calls = [];
    const controller = {
        describe: async (refs) => ({ [refs[0]]: { configured: false, writable: true } }),
        set: async (ref, value) => calls.push(["set", ref, value]),
        unset: async (ref) => calls.push(["unset", ref]),
    };
    const routes = [];
    const { ctx, record } = fakeContext({
        // `credentialsController` is read from the PLUGIN context through the
        // optional guard, so it must be visible there; `connection` only through
        // ctx.inject.
        inject: ["tools", "credentialsController"],
        services: {
            credentialsController: controller,
            connection: {
                fetch: {
                    register: (route) => {
                        routes.push(route);
                        return async () => {};
                    },
                },
            },
        },
    });
    await apply(ctx, {});

    // `connection` is requested through ctx.inject, never listed in `inject`.
    assert.deepEqual(record.injectedDeps, [["connection"]]);
    assert.equal(inject.includes("connection"), false);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, SETTINGS_ROUTE);
    assert.deepEqual(routes[0].methods, ["POST"]);
    assert.equal(routes[0].requestBody, "buffered");

    const response = await routes[0].fetch(new Request("http://127.0.0.1/api/dsh-zhihu-global-search/settings", {
        method: "POST",
        body: JSON.stringify({ op: "save", value: "value-1" }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    // The request never names a reference: the config's bound one wins.
    assert.deepEqual(calls[0], ["set", "ZHIHU_ACCESS_SECRET", "value-1"]);
});

test("a host without a connection carrier keeps the tool working", async () => {
    const { ctx, record } = fakeContext();
    await apply(ctx, {});
    assert.equal(record.tools.length, 1);
    assert.deepEqual(record.injectedDeps, [["connection"]]);
    assert.equal(record.warnings.length, 0);
});

test("mountSettingsRoute pre-binds a custom reference and is a no-op without a carrier", () => {
    const routes = [];
    const { ctx } = fakeContext({
        services: {
            connection: { fetch: { register: (route) => (routes.push(route), async () => {}) } },
        },
    });
    mountSettingsRoute(ctx, "ZHIHU_TEAM_SECRET");
    assert.equal(routes.length, 1);
});
