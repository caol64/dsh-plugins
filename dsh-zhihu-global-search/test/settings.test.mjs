import assert from "node:assert/strict";
import { test } from "node:test";

const { createSettingsOperations, MAX_SECRET_CHARS, normalizeSubmittedSecret, toSettingsView } = await import(
    "../src/settings.mjs"
);

const REF = "ZHIHU_ACCESS_SECRET";

/**
 * A credential controller stand-in that keeps a tiny in-memory store and
 * records calls.
 * @param {{ value?: string, source?: string, writable?: boolean, failSet?: string }} [options] - store state.
 */
function fakeController(options = {}) {
    const state = { value: options.value, source: options.source, writable: options.writable ?? true };
    const calls = [];
    return {
        calls,
        state,
        async describe(refs) {
            calls.push(["describe", refs]);
            const info = { configured: state.value !== undefined && state.value !== "", writable: state.writable };
            if (info.configured) info.source = state.source ?? "credentials";
            return { [refs[0]]: info };
        },
        async set(ref, value) {
            calls.push(["set", ref, value]);
            if (options.failSet) throw new Error(options.failSet);
            state.value = value;
            state.source = "credentials";
        },
        async unset(ref) {
            calls.push(["unset", ref]);
            state.value = undefined;
        },
    };
}

test("normalizeSubmittedSecret trims, rejects blanks, multi-line values and oversized input", () => {
    assert.equal(normalizeSubmittedSecret({ value: "  abc  " }), "abc");
    assert.throws(() => normalizeSubmittedSecret({ value: "   " }), /不能为空/u);
    assert.throws(() => normalizeSubmittedSecret({}), /不能为空/u);
    assert.throws(() => normalizeSubmittedSecret({ value: "a\nb" }), /换行/u);
    assert.throws(() => normalizeSubmittedSecret({ value: "x".repeat(MAX_SECRET_CHARS + 1) }), /过长/u);
});

test("toSettingsView never has a field a value could ride in", () => {
    const view = toSettingsView(REF, { configured: true, source: "credentials", writable: true }, true);
    assert.deepEqual(Object.keys(view).sort(), ["configured", "ref", "source", "store", "writable"]);
    // writable requires a store; a describe result alone cannot claim it.
    assert.equal(toSettingsView(REF, { configured: true, writable: true }, false).writable, false);
});

test("settings reports an empty state as unconfigured and writable", async () => {
    const operations = createSettingsOperations({ controller: fakeController(), ref: REF });
    assert.deepEqual(await operations.settings(), { ref: REF, configured: false, writable: true, store: true });
});

test("save writes through the controller and reports the new state without the value", async () => {
    const controller = fakeController();
    const operations = createSettingsOperations({ controller, ref: REF });
    const view = await operations.save({ value: " new-secret " });
    assert.deepEqual(controller.calls[0], ["set", REF, "new-secret"]);
    assert.deepEqual(view, { ref: REF, configured: true, source: "credentials", writable: true, store: true });
    assert.equal(JSON.stringify(view).includes("new-secret"), false);
});

test("clear removes the stored value and falls back to the environment state", async () => {
    const controller = fakeController({ value: "stored" });
    const operations = createSettingsOperations({ controller, ref: REF });
    assert.deepEqual(await operations.clear(), { ref: REF, configured: false, writable: true, store: true });
    assert.deepEqual(controller.calls[0], ["unset", REF]);
});

test("an environment-provided secret is reported read-only", async () => {
    const controller = fakeController({ value: "from-env", source: "env", writable: false });
    const operations = createSettingsOperations({ controller, ref: REF });
    const view = await operations.settings();
    assert.equal(view.configured, true);
    assert.equal(view.source, "env");
    assert.equal(view.writable, false);
});

test("a provider refusal is surfaced with the value redacted", async () => {
    const controller = fakeController({ failSet: "refused value hunter2 for ZHIHU_ACCESS_SECRET" });
    const operations = createSettingsOperations({ controller, ref: REF });
    await assert.rejects(operations.save({ value: "hunter2" }), (error) => {
        assert.match(error.message, /refused value \*\*\*/u);
        assert.equal(error.message.includes("hunter2"), false);
        return true;
    });
});

test("a describe failure degrades to an unconfigured view instead of throwing", async () => {
    const controller = {
        async describe() {
            throw new Error("offline");
        },
        async set() {},
        async unset() {},
    };
    const warnings = [];
    const operations = createSettingsOperations({
        controller,
        ref: REF,
        logger: { warn: (...args) => warnings.push(args.join(" ")) },
    });
    // A failed read is reported as unknown, distinguishable from "not configured".
    assert.deepEqual(await operations.settings(), {
        ref: REF,
        configured: false,
        writable: false,
        store: true,
        failed: true,
    });
    assert.equal(warnings.length, 1);
});

test("without a credential controller every operation still answers", async () => {
    const operations = createSettingsOperations({ ref: REF });
    assert.deepEqual(await operations.settings(), { ref: REF, configured: false, writable: false, store: false });
    await assert.rejects(operations.save({ value: "x" }), /没有可用的凭据存储/u);
    assert.deepEqual(await operations.clear(), { ref: REF, configured: false, writable: false, store: false });
});

test("a reference outside the credential grammar is refused at construction", () => {
    assert.throws(() => createSettingsOperations({ ref: "has-dash" }), /不支持的凭据引用名/u);
});