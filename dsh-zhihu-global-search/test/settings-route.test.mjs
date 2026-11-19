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

test("createSettingsRoute binds the credential controller and pre-binds the reference", async () => {
    const calls = [];
    const controller = {
        describe: async (refs) => ({ [refs[0]]: { configured: false, writable: true } }),
        set: async (ref, value) => calls.push(["set", ref, value]),
        unset: async (ref) => calls.push(["unset", ref]),
    };
    const ctx = new Proxy(
        {
            credentialsController: controller,
            logger: { info: () => {}, warn: () => {} },
        },
        {
            get(object, key) {
                if (typeof key === "string" && key in object) return Reflect.get(object, key);
                throw new Error(`cannot get property "${String(key)}" without inject`);
            },
        },
    );
    const handler = createSettingsRoute({ ctx, ref: "ZHIHU_TEAM_SECRET" });
    const saved = await (await handler(post('{"op":"save","value":"v1"}'))).json();
    assert.deepEqual(calls[0], ["set", "ZHIHU_TEAM_SECRET", "v1"]);
    assert.equal(saved.ok, true);
    // The request cannot name a reference; the bound one always wins.
    await handler(post('{"op":"save","value":"v2","ref":"OTHER_PLUGIN_SECRET"}'));
    assert.deepEqual(calls[1], ["set", "ZHIHU_TEAM_SECRET", "v2"]);
});