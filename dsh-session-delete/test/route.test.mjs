import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { apply, DELETE_ROUTE, DEFAULTS, harnessHome, resolveConfig } from "../index.mjs";

const ID = "session-route";

/**
 * Build a fake context whose `inject` runs the callback synchronously with a
 * child context that owns one route registry.
 * @param {Record<string, unknown>} services - fake services available to the child.
 * @returns {{ ctx: object, routes: object[], effects: number, emitted: Array<unknown[]> }} the fake host.
 */
function hostContext(services = {}) {
    const routes = [];
    const emitted = [];
    const effects = [];
    /** Services the plugin context did not inject: reading them must throw, as Cordis does. */
    const hidden = new Set(["connection", "sessionPersistence", "sessions", "agents", "sessionController", "workspaceRegistry", "storageDomain"]);
    const make = (target, absent) =>
        new Proxy(target, {
            get(object, key) {
                if (typeof key !== "string" || key in object) return Reflect.get(object, key);
                if (absent.has(key)) throw new Error(`cannot get property "${key}" without inject`);
                return services[key];
            },
        });
    const registered = make(
        {
            emit: (name, ...args) => emitted.push([name, ...args]),
            effect: (fn) => effects.push(fn()),
            connection: {
                fetch: {
                    register: (route) => {
                        routes.push(route);
                        return async () => {};
                    },
                },
            },
            logger: { info: () => {}, warn: () => {} },
        },
        new Set(),
    );
    const ctx = make(
        {
            inject: (deps, callback) => {
                assert.deepEqual(deps, ["connection"]);
                return callback(registered);
            },
            effect: (fn) => (typeof fn === "function" ? effects.push(fn()) : undefined),
            logger: { info: () => {}, warn: () => {} },
        },
        hidden,
    );
    return { ctx, routes, effects, emitted };
}

/**
 * Lay out one session under a fresh harness home, and point `DSH_HOME` at it
 * for the duration of the test. The Host reads `DSH_HOME` for the projection
 * cache and for the session root; the real value in a developer shell points at
 * `~/.dsh`, so the fixture owns the variable rather than inheriting it.
 * @param {import('node:test').TestContext} t - the running test (registers cleanup).
 * @returns {Promise<{ home: string, root: string, dir: string, log: string }>} the fixture paths.
 */
async function fixture(t) {
    const home = await mkdtemp(path.join(tmpdir(), "dsh-session-delete-route-"));
    const dir = path.join(home, "sessions", "--tmp--", ID);
    await mkdir(dir, { recursive: true });
    const log = path.join(dir, "session.v4.jsonl");
    await writeFile(log, "log");
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    t.after(() => {
        if (previous === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previous;
        return rm(home, { recursive: true, force: true });
    });
    return { home, root: path.join(home, "sessions"), dir, log };
}

/** A POST request carrying one JSON body. */
function post(body) {
    return new Request(`http://127.0.0.1:3080${DELETE_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

test("config defaults are the documented contract", () => {
    assert.deepEqual(resolveConfig(), DEFAULTS);
    assert.deepEqual(resolveConfig({}), DEFAULTS);
    assert.deepEqual(resolveConfig({ stopTimeoutMs: 1500, allowDeleteRunning: false, deleteProjectionCache: false }), {
        stopTimeoutMs: 1500,
        allowDeleteRunning: false,
        deleteProjectionCache: false,
    });
});

test("config rejects unknown keys and wrong types", () => {
    assert.throws(() => resolveConfig({ nope: true }), /unknown config key "nope"/);
    assert.throws(() => resolveConfig({ stopTimeoutMs: "1" }), /stopTimeoutMs/);
    assert.throws(() => resolveConfig({ stopTimeoutMs: -1 }), /stopTimeoutMs/);
    assert.throws(() => resolveConfig({ stopTimeoutMs: 10 ** 9 }), /stopTimeoutMs/);
    assert.throws(() => resolveConfig({ allowDeleteRunning: "yes" }), /allowDeleteRunning/);
});

test("harnessHome reads DSH_HOME and ignores a blank value", () => {
    const previous = process.env.DSH_HOME;
    try {
        process.env.DSH_HOME = "/tmp/isolated-home";
        assert.equal(harnessHome({}), "/tmp/isolated-home");
        process.env.DSH_HOME = "   ";
        assert.equal(harnessHome({}), undefined);
        delete process.env.DSH_HOME;
        assert.equal(harnessHome({}), undefined);
    } finally {
        if (previous === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previous;
    }
});

test("the route path carries the /api channel the carrier requires", () => {
    // endpointFromPath("/api", path) accepts only "/api/<segment>/<segment>";
    // anything else is rejected at registration and the route silently vanishes.
    assert.match(DELETE_ROUTE, /^\/api\/[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/);
    assert.equal(DELETE_ROUTE, "/api/dsh-session-delete/delete");
});

test("apply mounts exactly one POST route on the connection carrier", () => {
    const { ctx, routes } = hostContext();
    apply(ctx, {});
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, DELETE_ROUTE);
    assert.deepEqual(routes[0].methods, ["POST"]);
    assert.equal(routes[0].requestBody, "buffered");
    assert.equal(typeof routes[0].fetch, "function");
});

test("the route deletes a stored session and reports the outcome", async (t) => {
    const home = await fixture(t);
    const { ctx, routes } = hostContext({
        sessionPersistence: { stat: async (id) => (id === ID ? { header: { id }, location: { kind: "jsonl", path: home.log } } : undefined) },
    });
    apply(ctx, {});
    const response = await routes[0].fetch(post({ sessionId: ID }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { ok: true, sessionId: ID, stopped: false, removed: 1, warnings: [] });
    await assert.rejects(import("node:fs/promises").then((fs) => fs.access(home.dir)), { code: "ENOENT" });
});

test("the route maps refusal codes onto statuses and localized text", async (t) => {
    const home = await fixture(t);
    const { ctx, routes } = hostContext({ sessionPersistence: { stat: async () => undefined } });
    apply(ctx, {});
    const response = await routes[0].fetch(post({ sessionId: ID }));
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "session-not-found");
    assert.match(body.message, /已不存在/);
    assert.equal(body.removed, 0);
});

test("the route refuses a malformed id with 400", async () => {
    const { ctx, routes } = hostContext();
    apply(ctx, {});
    const response = await routes[0].fetch(post({ sessionId: "../../etc" }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid-id");
});

test("the route refuses a malformed body with 400", async () => {
    const { ctx, routes } = hostContext();
    apply(ctx, {});
    const response = await routes[0].fetch(post("{not json"));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid-id");
});

test("the route refuses an oversized body", async () => {
    const { ctx, routes } = hostContext();
    apply(ctx, {});
    const response = await routes[0].fetch(post({ sessionId: ID, padding: "x".repeat(8192) }));
    assert.equal(response.status, 400);
});

test("stopRunning:false turns a running session into agent-busy", async (t) => {
    const home = await fixture(t);
    const { ctx, routes } = hostContext({
        sessionPersistence: { stat: async () => ({ header: { id: ID }, location: { kind: "jsonl", path: home.log } }) },
        agents: { get: () => ({ status: "running" }) },
    });
    apply(ctx, {});
    const response = await routes[0].fetch(post({ sessionId: ID, stopRunning: false }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "agent-busy");
});

test("a host without a connection carrier keeps the plugin loaded", () => {
    let injected = false;
    const ctx = new Proxy(
        {
            inject: () => {
                injected = true;
                return undefined;
            },
        },
        {
            get(object, key) {
                if (typeof key === "string" && !(key in object)) throw new Error(`cannot get property "${key}" without inject`);
                return Reflect.get(object, key);
            },
        },
    );
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.equal(injected, true);
});