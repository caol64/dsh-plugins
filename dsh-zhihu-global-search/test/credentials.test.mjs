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

test("the resolver prefers the credential service over the environment", async () => {
    const seen = [];
    const resolver = createSecretResolver({
        ref: "DSH_TEST_SECRET",
        credentials: {
            resolve: async (ref) => {
                seen.push(ref);
                return { value: "from-store", source: "credentials" };
            },
        },
    });
    process.env.DSH_TEST_SECRET = "from-env";
    try {
        assert.deepEqual(await resolver.resolve(), { value: "from-store", source: "credentials" });
        assert.deepEqual(seen, ["DSH_TEST_SECRET"]);
    } finally {
        delete process.env.DSH_TEST_SECRET;
    }
});

test("the resolver falls back to the environment when the store has nothing", async () => {
    process.env.DSH_TEST_SECRET = "  from-env  ";
    try {
        const empty = createSecretResolver({ ref: "DSH_TEST_SECRET", credentials: { resolve: async () => undefined } });
        assert.deepEqual(await empty.resolve(), { value: "from-env", source: "env" });

        // An empty stored value counts as absent (the seam's own rule).
        const blank = createSecretResolver({
            ref: "DSH_TEST_SECRET",
            credentials: { resolve: async () => ({ value: "   ", source: "credentials" }) },
        });
        assert.deepEqual(await blank.resolve(), { value: "from-env", source: "env" });
    } finally {
        delete process.env.DSH_TEST_SECRET;
    }
});

test("a failing credential provider degrades to the environment instead of throwing", async () => {
    process.env.DSH_TEST_SECRET = "from-env";
    try {
        const resolver = createSecretResolver({
            ref: "DSH_TEST_SECRET",
            credentials: {
                resolve: async () => {
                    throw new Error("provider offline");
                },
            },
        });
        assert.deepEqual(await resolver.resolve(), { value: "from-env", source: "env" });
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
        credentials: { resolve: async () => ({ value: "secret-value", source: "credentials" }) },
    });
    const hit = await resolver.resolve();
    assert.deepEqual(Object.keys(hit).sort(), ["source", "value"]);
});