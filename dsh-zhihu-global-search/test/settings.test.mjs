/**
 * The settings operations, now backed by THIS plugin's own store.
 *
 * The operations no longer touch any host service, so these tests use a real
 * file-backed store in a temporary directory: the behavior under test is the
 * one the page experiences, including the environment fallback and the way a
 * corrupt document is reported.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createSettingsOperations, MAX_SECRET_CHARS, normalizeSubmittedSecret, toSettingsView } = await import(
    "../src/settings.mjs"
);
const { createSecretStore } = await import("../src/secret-store.mjs");

const REF = "ZHIHU_ACCESS_SECRET";

/**
 * A real store in a fresh directory plus a controlled environment.
 * @param {import("node:test").TestContext} t - test context, for cleanup.
 * @param {Record<string, string>} [env] - environment values.
 * @returns {Promise<{ store: object, env: Record<string, string>, dir: string }>} fixture.
 */
async function fixture(t, env = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "zgs-settings-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = path.join(root, "store");
    return { store: createSecretStore({ dir }), env, dir };
}

test("normalizeSubmittedSecret trims, rejects blanks, multi-line values and oversized input", () => {
    assert.equal(normalizeSubmittedSecret({ value: "  abc  " }), "abc");
    assert.throws(() => normalizeSubmittedSecret({ value: "   " }), /不能为空/u);
    assert.throws(() => normalizeSubmittedSecret({ value: 42 }), /不能为空/u);
    assert.throws(() => normalizeSubmittedSecret(null), /不能为空/u);
    assert.throws(() => normalizeSubmittedSecret({ value: "a\nb" }), /换行/u);
    assert.throws(() => normalizeSubmittedSecret({ value: "x".repeat(MAX_SECRET_CHARS + 1) }), /过长/u);
});

test("toSettingsView never has a field a value could ride in", () => {
    const view = toSettingsView(REF, { configured: true, source: "plugin", writable: true }, "plugin", "/s");
    assert.deepEqual(Object.keys(view).sort(), ["configured", "location", "ref", "source", "store", "writable"]);
    assert.equal(toSettingsView(REF, { configured: true, writable: true }, false).writable, true);
    assert.equal(toSettingsView(REF, { configured: true, writable: true }, false).store, false);
});

test("an empty store reports unconfigured and writable", async (t) => {
    const { store, env, dir } = await fixture(t);
    const operations = createSettingsOperations({ store, ref: REF, env });
    assert.deepEqual(await operations.settings(), {
        ref: REF,
        configured: false,
        writable: true,
        store: "plugin",
        location: dir,
    });
});

test("save writes to the plugin's own file and the view never carries the value", async (t) => {
    const { store, env, dir } = await fixture(t);
    const operations = createSettingsOperations({ store, ref: REF, env });
    const view = await operations.save({ value: "  zhihu-secret-1  " });
    assert.deepEqual(view, {
        ref: REF,
        configured: true,
        source: "plugin",
        writable: true,
        store: "plugin",
        location: dir,
    });
    assert.equal(JSON.stringify(view).includes("zhihu-secret-1"), false);
    // The document lives where this plugin alone owns it.
    const document = JSON.parse(await readFile(path.join(dir, "secret.json"), "utf8"));
    assert.equal(document.secret, "zhihu-secret-1");
    assert.equal(await store.read(), "zhihu-secret-1");
});

test("clear drops the stored value and reports the resulting state", async (t) => {
    const { store, env } = await fixture(t);
    const operations = createSettingsOperations({ store, ref: REF, env });
    await operations.save({ value: "value-1" });
    const view = await operations.clear();
    assert.equal(view.configured, false);
    assert.equal(view.writable, true);
    assert.equal(await store.read(), undefined);
});

test("an environment-provided secret is reported, and the store still accepts a value", async (t) => {
    const { store } = await fixture(t, { [REF]: "from-env" });
    const operations = createSettingsOperations({ store, ref: REF, env: { [REF]: "from-env" } });
    const view = await operations.settings();
    assert.equal(view.configured, true);
    assert.equal(view.source, "env");
    assert.equal(view.writable, true);
    // Saving stores a value that then takes precedence over the environment.
    const saved = await operations.save({ value: "from-store" });
    assert.equal(saved.source, "plugin");
    assert.equal(await store.read(), "from-store");
});

test("the stored value wins over the environment", async (t) => {
    const { store } = await fixture(t);
    const operations = createSettingsOperations({ store, ref: REF, env: { [REF]: "from-env" } });
    await operations.save({ value: "from-store" });
    assert.equal((await operations.settings()).source, "plugin");
});

test("a write refusal is surfaced with the value redacted", async (t) => {
    const { dir } = await fixture(t);
    // A store whose write fails while naming the submitted value.
    const hostile = {
        directory: dir,
        describe: async () => ({ configured: false, writable: true }),
        write: async (value) => {
            throw new Error(`refused value ${value} for ${REF}`);
        },
        clear: async () => {},
    };
    const operations = createSettingsOperations({ store: hostile, ref: REF, env: {} });
    await assert.rejects(() => operations.save({ value: "hunter2" }), (error) => {
        assert.match(error.message, /refused value/u);
        assert.equal(error.message.includes("hunter2"), false, "the value leaked into the error");
        return true;
    });
});

test("a corrupt store shows failed:true instead of claiming nothing is stored", async (t) => {
    const { store, env, dir } = await fixture(t);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "secret.json"), "{ broken", { mode: 0o600 });
    const operations = createSettingsOperations({ store, ref: REF, env });
    const view = await operations.settings();
    assert.equal(view.failed, true);
    assert.equal(view.configured, false);
});

test("without a store every operation still answers, preferring the environment message", async (t) => {
    const operations = createSettingsOperations({ store: undefined, ref: REF, env: { [REF]: "from-env" } });
    const view = await operations.settings();
    assert.deepEqual(view, { ref: REF, configured: true, source: "env", writable: false, store: false });
    await assert.rejects(() => operations.save({ value: "x" }), /没有可用的插件存储/u);
    await assert.rejects(() => operations.clear(), /没有可用的插件存储/u);
});

test("an environment name outside the POSIX grammar is refused at construction", () => {
    assert.throws(() => createSettingsOperations({ store: undefined, ref: "bad-name" }), /不支持的环境变量名/u);
    assert.throws(() => createSettingsOperations({ store: undefined, ref: "" }), /不支持的环境变量名/u);
});