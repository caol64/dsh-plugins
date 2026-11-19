/**
 * The plugin's own secret store.
 *
 * These tests assert the properties that make a private store worth having, not
 * just that a value round-trips: owner-only permissions, atomic replacement, and
 * a corrupt document that FAILS LOUDLY instead of reading as "not configured".
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const {
    createSecretStore,
    harnessHome,
    isOwnerOnly,
    parseStoreDocument,
    resolveStoreDir,
    STORE_DIR_NAME,
    STORE_FILE_NAME,
} = await import("../src/secret-store.mjs");

/**
 * A store in a fresh temporary directory.
 * @param {import("node:test").TestContext} t - test context, for cleanup.
 * @returns {Promise<{ store: object, dir: string, file: string }>} the store and its paths.
 */
async function tempStore(t) {
    const root = await mkdtemp(path.join(tmpdir(), "zgs-store-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = path.join(root, STORE_DIR_NAME);
    return { store: createSecretStore({ dir }), dir, file: path.join(dir, STORE_FILE_NAME) };
}

test("the store directory is the package name under the storage root", () => {
    assert.equal(resolveStoreDir({ storageRoot: "/h/.dsh/storages" }), path.resolve("/h/.dsh/storages", STORE_DIR_NAME));
    assert.equal(resolveStoreDir({ dir: "/custom/store" }), path.resolve("/custom/store"));
    assert.equal(resolveStoreDir({}), undefined);
    assert.equal(harnessHome({ DSH_HOME: "/x/.dsh" }), "/x/.dsh");
    assert.equal(harnessHome({ HOME: "/home/u" }), path.join("/home/u", ".dsh"));
});

test("an empty store reports unconfigured and reads undefined", async (t) => {
    const { store } = await tempStore(t);
    assert.deepEqual(await store.describe(), { configured: false, writable: true });
    assert.equal(await store.read(), undefined);
});

test("a saved value round-trips and the status carries no value", async (t) => {
    const { store } = await tempStore(t);
    await store.write("zhihu-access-abc");
    assert.deepEqual(await store.describe(), { configured: true, source: "plugin", writable: true });
    assert.equal(await store.read(), "zhihu-access-abc");
    // The view is the only thing a page receives: it must not carry the secret.
    const view = await store.describe();
    assert.equal(JSON.stringify(view).includes("zhihu-access-abc"), false);
});

test("the directory is 0700 and the file 0600", async (t) => {
    const { store, dir, file } = await tempStore(t);
    await store.write("value");
    assert.equal((await stat(dir)).mode & 0o777, 0o700, "store directory must be owner-only");
    assert.equal((await stat(file)).mode & 0o777, 0o600, "store file must be owner-only");
    assert.equal(isOwnerOnly((await stat(file)).mode), true);
});

test("an existing directory with loose permissions is tightened on write", async (t) => {
    const { store, dir } = await tempStore(t);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await store.write("value");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("writing replaces the document atomically and leaves no temporary file", async (t) => {
    const { store, file, dir } = await tempStore(t);
    await store.write("first");
    await store.write("second");
    assert.equal(await store.read(), "second");
    const { readdir } = await import("node:fs/promises");
    const leftover = (await readdir(dir)).filter((entry) => entry !== STORE_FILE_NAME);
    assert.deepEqual(leftover, [], "a temporary file was left behind");
    // The document is what this plugin wrote, and nothing else.
    const document = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(Object.keys(document).sort(), ["secret", "version"]);
});

test("clearing removes the document and the store reads as unconfigured", async (t) => {
    const { store } = await tempStore(t);
    await store.write("value");
    await store.clear();
    assert.deepEqual(await store.describe(), { configured: false, writable: true });
    assert.equal(await store.read(), undefined);
    // Clearing an already-empty store is a no-op, not a failure.
    await assert.doesNotReject(() => store.clear());
});

test("a corrupt document fails loudly instead of reading as unconfigured", async (t) => {
    const { store, dir } = await tempStore(t);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, STORE_FILE_NAME), "{ not json", { mode: 0o600 });
    assert.deepEqual(await store.describe(), { configured: false, writable: true, failed: true });
    await assert.rejects(() => store.read(), /不是合法的 JSON/u);
});

test("a document from an unsupported version is refused", async (t) => {
    const { store, dir } = await tempStore(t);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, STORE_FILE_NAME), JSON.stringify({ version: 99, secret: "x" }), { mode: 0o600 });
    assert.deepEqual(await store.describe(), { configured: false, writable: true, failed: true });
    await assert.rejects(() => store.read(), /版本不受支持/u);
});

test("a document with an invalid secret field is refused, never guessed", async (t) => {
    const { store, dir } = await tempStore(t);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, STORE_FILE_NAME);
    for (const document of [{ version: 1, secret: 42 }, { version: 1, secret: "   " }, { version: 1 }]) {
        await writeFile(file, JSON.stringify(document), { mode: 0o600 });
        if ("secret" in document) {
            await assert.rejects(() => store.read(), /secret 字段无效/u, JSON.stringify(document));
        } else {
            // No `secret` key at all: a deliberate "nothing stored" document.
            assert.equal(await store.read(), undefined);
        }
    }
});

test("the parser accepts only the document shape this plugin writes", () => {
    assert.equal(parseStoreDocument(JSON.stringify({ version: 1, secret: "abc" })), "abc");
    assert.throws(() => parseStoreDocument("[]"), /结构不正确/u);
    assert.throws(() => parseStoreDocument("null"), /结构不正确/u);
});