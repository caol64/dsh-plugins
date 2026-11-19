import assert from "node:assert/strict";
import { test } from "node:test";

const { DEFAULT_SECRET_REF, assertNoLiteralSecret, createSecretResolver, fromEnvironment, isCredentialRefName } =
    await import("../src/credentials.mjs");

test("only POSIX identifiers can name a credential reference", () => {
    assert.equal(isCredentialRefName(DEFAULT_SECRET_REF), true);
    assert.equal(isCredentialRefName("_x1"), true);
    assert.equal(isCredentialRefName("1BAD"), false);
    assert.equal(isCredentialRefName("has-dash"), false);
    assert.equal(isCredentialRefName(""), false);
    assert.equal(isCredentialRefName(undefined), false);
});

test("a config key that looks like a secret is rejected with the right guidance", () => {
    for (const key of ["accessSecret", "apiKey", "api_key", "token", "authPassword"]) {
        assert.throws(
            () => assertNoLiteralSecret({ [key]: "literal" }, ["accessSecretEnv"]),
            /secrets never go in configuration/u,
            key,
        );
    }
    // Unknown non-secret keys still fail, just with the plain message.
    assert.throws(() => assertNoLiteralSecret({ nope: 1 }, ["accessSecretEnv"]), /unknown config key "nope"/u);
    assert.doesNotThrow(() => assertNoLiteralSecret({ accessSecretEnv: "A" }, ["accessSecretEnv"]));
});

test("the resolver prefers the plugin's own store over the environment", async () => {
    let reads = 0;
    const resolver = createSecretResolver({
        ref: "DSH_TEST_SECRET",
        store: {
            read: async () => {
                reads += 1;
                return "from-plugin-store";
            },
        },
    });
    process.env.DSH_TEST_SECRET = "from-env";
    try {
        assert.deepEqual(await resolver.resolve(), { value: "from-plugin-store", source: "plugin" });
        assert.equal(reads, 1);
    } finally {
        delete process.env.DSH_TEST_SECRET;
    }
});

test("the resolver falls back to the environment when the store has nothing", async () => {
    process.env.DSH_TEST_SECRET = "  from-env  ";
    try {
        const empty = createSecretResolver({ ref: "DSH_TEST_SECRET", store: { read: async () => undefined } });
        assert.deepEqual(await empty.resolve(), { value: "from-env", source: "env" });

        // An empty stored value counts as absent.
        const blank = createSecretResolver({ ref: "DSH_TEST_SECRET", store: { read: async () => "   " } });
        assert.deepEqual(await blank.resolve(), { value: "from-env", source: "env" });
    } finally {
        delete process.env.DSH_TEST_SECRET;
    }
});

test("a broken store is reported, never silently downgraded to the environment", async () => {
    // Silently falling back would show "configured" while a corrupt secret file
    // sits on disk — the user could never tell why their key is not the one used.
    process.env.DSH_TEST_SECRET = "from-env";
    try {
        const resolver = createSecretResolver({
            ref: "DSH_TEST_SECRET",
            store: {
                read: async () => {
                    throw new Error("插件存储文件不是合法的 JSON");
                },
            },
        });
        await assert.rejects(() => resolver.resolve(), /读取插件存储失败/u);
    } finally {
        delete process.env.DSH_TEST_SECRET;
    }
});

test("an unconfigured reference resolves to undefined, never to a blank string", async () => {
    delete process.env.DSH_TEST_SECRET;
    assert.equal(fromEnvironment("DSH_TEST_SECRET"), undefined);
    const resolver = createSecretResolver({ ref: "DSH_TEST_SECRET" });
    assert.equal(await resolver.resolve(), undefined);
});

test("no resolution result carries anything but the value and its source", async () => {
    const resolver = createSecretResolver({
        ref: "DSH_TEST_SECRET",
        store: { read: async () => "secret-value" },
    });
    const hit = await resolver.resolve();
    assert.deepEqual(Object.keys(hit).sort(), ["source", "value"]);
});