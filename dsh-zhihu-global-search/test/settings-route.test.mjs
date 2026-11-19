/**
 * The settings route's wire contract: path shape, request parsing, status
 * mapping, and the guarantee that no response can carry the secret.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    createSettingsRoute,
    handleSettingsRequest,
    parseSettingsRequest,
    SETTINGS_OPERATIONS,
    SETTINGS_ROUTE,
} from "../src/settings-route.mjs";

/** The carrier's own rule: `/api/<segment>/<segment>`, segments `[A-Za-z0-9_$.-]+`. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/u;

/**
 * A request-shaped stand-in; only `text()` is read.
 * @param {string} body - the raw body.
 * @returns {{ text: () => Promise<string> }} request stub.
 */
const post = (body) => ({ text: async () => body });

/**
 * Operations backed by a tiny in-memory store, recording calls.
 * @param {{ value?: string, failSave?: string }} [state] - store state.
 */
function operations(state = {}) {
    const store = { value: state.value };
    const calls = [];
    return {
        calls,
        store,
        async settings() {
            calls.push(["settings"]);
            return {
                ref: "ZHIHU_ACCESS_SECRET",
                configured: store.value !== undefined,
                writable: true,
                store: true,
            };
        },
        async save({ value }) {
            calls.push(["save", value]);
            if (state.failSave) throw new Error(state.failSave);
            store.value = value;
            return this.settings();
        },
        async clear() {
            calls.push(["clear"]);
            store.value = undefined;
            return { ref: "ZHIHU_ACCESS_SECRET", configured: false, writable: true, store: true };
        },
    };
}

test("the route path satisfies the carrier's exact-route grammar", () => {
    assert.match(SETTINGS_ROUTE, /^\/api\/[^/]+\/[^/]+$/u);
    const [, first, second] = SETTINGS_ROUTE.split("/");
    for (const segment of [first, second]) assert.match(segment, ENDPOINT_SEGMENT);
    assert.equal(SETTINGS_ROUTE, "/api/dsh-zhihu-global-search/settings");
});

test("the operations are exactly the three the page drives", () => {
    assert.deepEqual([...SETTINGS_OPERATIONS], ["settings", "save", "clear"]);
});

test("parseSettingsRequest defaults to the read operation", async () => {
    assert.deepEqual(await parseSettingsRequest(post("")), { op: "settings", value: undefined });
    assert.deepEqual(await parseSettingsRequest(post('{"op":"settings"}')), { op: "settings", value: undefined });
});

test("parseSettingsRequest carries a save value and a clear request", async () => {
    assert.deepEqual(await parseSettingsRequest(post('{"op":"save","value":"abc"}')), { op: "save", value: "abc" });
    assert.deepEqual(await parseSettingsRequest(post('{"op":"clear"}')), { op: "clear", value: undefined });
});

test("parseSettingsRequest refuses non-JSON, non-object, unknown, and oversized bodies", async () => {
    await assert.rejects(parseSettingsRequest(post("{not json")), /not JSON/u);
    await assert.rejects(parseSettingsRequest(post("[]")), /not an object/u);
    await assert.rejects(parseSettingsRequest(post('{"op":"drop-everything"}')), /unknown operation/u);
    await assert.rejects(parseSettingsRequest(post(`{"op":"save","value":"${"x".repeat(9000)}"}`)), /too large/u);
});

test("the read operation answers the view and never a value", async () => {
    const ops = operations({ value: "stored-secret" });
    const response = await handleSettingsRequest({ operations: ops }, post('{"op":"settings"}'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, {
        ok: true,
        ref: "ZHIHU_ACCESS_SECRET",
        configured: true,
        writable: true,
        store: true,
    });
    assert.equal(JSON.stringify(body).includes("stored-secret"), false);
});

test("save persists through the operations and returns the new view", async () => {
    const ops = operations();
    const response = await handleSettingsRequest({ operations: ops }, post('{"op":"save","value":"new-secret"}'));
    assert.equal(response.status, 200);
    assert.deepEqual(ops.calls[0], ["save", "new-secret"]);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.configured, true);
    assert.equal(JSON.stringify(body).includes("new-secret"), false);
});

test("clear removes the stored value", async () => {
    const ops = operations({ value: "old" });
    const response = await handleSettingsRequest({ operations: ops }, post('{"op":"clear"}'));
    assert.deepEqual(await response.json(), {
        ok: true,
        ref: "ZHIHU_ACCESS_SECRET",
        configured: false,
        writable: true,
        store: true,
    });
});

test("a malformed body is a 400 with a stable code, never a stack", async () => {
    const response = await handleSettingsRequest({ operations: operations() }, post("{not json"));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "bad-request");
    assert.equal(body.message, "request body is not JSON");
});

test("a refused write is a 500 with the provider message redacted by the operations", async () => {
    const warnings = [];
    const ops = operations({ failSave: "store refused ******" });
    const response = await handleSettingsRequest(
        { operations: ops, onWarn: (message) => warnings.push(message) },
        post('{"op":"save","value":"hunter2"}'),
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, "settings-failed");
    assert.equal(JSON.stringify(body).includes("hunter2"), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /settings save failed/u);
});

test("a missing credential store answers 503 so the page can explain it", async () => {
    const ops = {
        async settings() {
            return { ref: "ZHIHU_ACCESS_SECRET", configured: false, writable: false, store: false };
        },
        async save() {
            throw new Error("当前环境没有可用的凭据存储，请改写环境变量 accessSecretEnv 指定的变量。");
        },
        async clear() {
            return { ref: "ZHIHU_ACCESS_SECRET", configured: false, writable: false, store: false };
        },
    };
    const response = await handleSettingsRequest({ operations: ops }, post('{"op":"save","value":"x"}'));
    assert.equal(response.status, 503);
});

test("the route writes into this plugin's own store and reports its location", async (t) => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createSecretStore } = await import("../src/secret-store.mjs");

    const root = await mkdtemp(path.join(tmpdir(), "zgs-route-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = path.join(root, "store");
    const store = createSecretStore({ dir });
    // A host context that is hostile to property access: the route must need no
    // service beyond a logger, so a real Cordis "without inject" throw on every
    // key cannot disable the page (that is what broke earlier versions).
    const ctx = new Proxy(
        { logger: { info: () => {}, warn: () => {} } },
        {
            get(object, key) {
                if (typeof key === "string" && key in object) return Reflect.get(object, key);
                throw new Error(`cannot get property "${String(key)}" without inject`);
            },
        },
    );
    const handler = createSettingsRoute({ ctx, store, ref: "ZHIHU_ACCESS_SECRET" });
    const secret = "zhihu-hidden-value";
    const saved = await (await handler(post(JSON.stringify({ op: "save", value: secret })))).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.store, "plugin");
    assert.equal(saved.configured, true);
    assert.equal(saved.location, dir);
    // Every field but the value: nothing in the view may carry the secret.
    for (const value of Object.values(saved)) assert.notEqual(value, secret);
    assert.equal(await store.read(), secret);

    // The request cannot choose the environment fallback name either.
    await handler(post(JSON.stringify({ op: "save", value: "second-value", ref: "OTHER_PLUGIN_SECRET" })));
    assert.equal(await store.read(), "second-value");

    const cleared = await (await handler(post('{"op":"clear"}'))).json();
    assert.equal(cleared.configured, false);
    assert.equal(await store.read(), undefined);
});
