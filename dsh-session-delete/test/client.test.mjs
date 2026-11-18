/**
 * Drive the real browser half under a minimal module-loader shim.
 *
 * `client.js` is a lazy factory registered on `window.__ModuleLoader__`; loading
 * it needs only that global plus a `require` for the seeds it names. Everything
 * the factory does with the host is reached through the fake client context
 * this file builds, so the assertions below test the shipped code rather than a
 * transcription of it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DELETE_ERROR_CODES } from "../src/errors.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = await readFile(path.join(ROOT, "client.js"), "utf8");

/** React stand-ins: enough for the factory to build elements without a DOM. */
const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    createContext: (value) => ({ Provider: "Provider", value }),
    useContext: () => undefined,
    Fragment: "Fragment",
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
};

/**
 * Evaluate the factory and return its exported plugin object.
 * @returns {{ inject: string[], apply: (ctx: object) => void }} the client plugin.
 */
function loadPlugin() {
    let registration;
    const window = { __ModuleLoader__: { load: (value) => (registration = value) } };
    const seats = { react: React, locale: { register: () => () => {} } };
    const run = new Function("window", "require", `with (window) { ${SOURCE} }`);
    run(window, (name) => {
        if (!(name in seats)) throw new Error(`unexpected seed "${name}"`);
        return seats[name];
    });
    assert.ok(registration, "the bundle registered a factory");
    assert.equal(registration.id, "dsh-session-delete");
    return { windows: window, plugin: registration.factory((name) => seats[name]) };
}

/**
 * Build a fake client context that records registrations and resources.
 * @returns {{ ctx: object, records: Record<string, unknown[]>, disposed: number }} the fake context.
 */
function clientContext() {
    const records = { locale: [], slots: [], injected: [], effects: [], disposed: 0 };
    const localeService = {
        getLocale: () => ({ id: "zh-CN" }),
        subscribe: () => () => {},
        register: (ns, dicts) => {
            records.locale.push({ ns, dicts });
            return () => {
                records.disposed += 1;
            };
        },
    };
    const ctx = {
        get: (key) => (key === "locale" ? localeService : undefined),
        effect: (fn, label) => {
            records.effects.push(label);
            // Cordis runs the effect body immediately and adds whatever it
            // returns to the fiber; the registration must happen right here.
            const disposer = fn();
            return typeof disposer === "function" ? disposer : () => {};
        },
        slots: {
            inject: (slot, callback) => {
                // Cordis runs the callback straight away when the slot is already
                // declared and re-runs it whenever the declaration returns; the
                // test treats the slot as declared so registrations happen here.
                records.injected.push(slot);
                const disposer = callback();
                return typeof disposer === "function" ? disposer : () => {};
            },
            register: (options, component) => {
                records.slots.push({ options, component });
                return () => {};
            },
        },
    };
    return { ctx, records };
}

test("the client half declares only the slots service", () => {
    const { plugin } = loadPlugin();
    assert.deepEqual(plugin.inject, ["slots"]);
    assert.equal(typeof plugin.apply, "function");
});

test("apply registers the locale dictionaries and the menu entry", () => {
    const { plugin } = loadPlugin();
    const { ctx, records } = clientContext();
    plugin.apply(ctx);

    assert.equal(records.locale.length, 1);
    assert.equal(records.locale[0].ns, "session-delete");
    assert.deepEqual(Object.keys(records.locale[0].dicts), ["zh-CN", "en"]);
    assert.deepEqual(records.injected, ["sidebar.workspaces.session.menu.item"]);

    assert.equal(records.slots.length, 1);
    const { options, component } = records.slots[0];
    assert.equal(options.name, "sidebar.workspaces.session.menu.item");
    assert.equal(options.id, "session-delete");
    assert.equal(options.order, 1000, "the entry sorts after the built-in entries");
    assert.equal(options.label(), "删除会话");
    assert.equal(typeof component, "function");
});

test("the menu label follows the active language", () => {
    const { plugin } = loadPlugin();
    const english = {
        getLocale: () => ({ id: "en" }),
        subscribe: () => () => {},
        register: () => () => {},
    };
    const { ctx, records } = clientContext();
    ctx.get = (key) => (key === "locale" ? english : undefined);
    plugin.apply(ctx);
    assert.equal(records.slots[0].options.label(), "Delete session");
});

test("apply survives a context without a locale service", () => {
    const { plugin } = loadPlugin();
    const { ctx, records } = clientContext();
    ctx.get = () => undefined;
    assert.doesNotThrow(() => plugin.apply(ctx));
    assert.equal(records.slots.length, 1);
    assert.equal(records.slots[0].options.label(), "删除会话");
});

test("every Host failure code has a client sentence in both languages", () => {
    const { plugin } = loadPlugin();
    const { ctx, records } = clientContext();
    plugin.apply(ctx);
    const dicts = records.locale[0].dicts;
    for (const locale of ["zh-CN", "en"]) {
        for (const code of DELETE_ERROR_CODES) {
            const sentence = dicts[locale].error[code];
            assert.equal(typeof sentence, "string", `${locale} translates "${code}"`);
            assert.ok(sentence.length > 0, `${locale} "${code}" is not empty`);
        }
    }
    assert.deepEqual(Object.keys(dicts.en.error).sort(), Object.keys(dicts["zh-CN"].error).sort());
});

test("the client calls the same route the Host mounts", async () => {
    const { DELETE_ROUTE } = await import("../index.mjs");
    const match = SOURCE.match(/const DELETE_URL = "([^"]+)"/);
    assert.ok(match, "DELETE_URL is declared");
    // The browser calls the route relatively so it follows the page mount.
    assert.equal(`/${match[1]}`, DELETE_ROUTE);
});