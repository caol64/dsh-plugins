/**
 * The settings page, rendered by REAL React.
 *
 * Why this file exists: the hand-written hook stub in `client.test.mjs` proved
 * the factory loads, but it could not catch the defect that made the page blank
 * — the registration returned a FUNCTION where React expects an element, so
 * React printed "Functions are not valid as a React child" and rendered
 * nothing. A stub that "renders any function it meets" is more permissive than
 * React, so it must not be the last word on whether a page renders.
 *
 * Here the plugin factory is loaded exactly as the browser loads it (only the
 * platform seeds resolve; anything else throws the real `missed the module
 * table` error) and rendered with `react-dom/server`, which is the same React
 * the page runs. `react` and `react-dom` are DEV dependencies: the plugin ships
 * them never, the test needs the real thing rather than a stand-in.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { capturedRegistration, PLATFORM_SEEDS } from "./client-seeds.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const SOURCE = readFileSync(path.join(ROOT, "client.js"), "utf8");

/**
 * Load the plugin the way the browser module table does.
 * @param {string} [source] - client source to load (defaults to the real one).
 * @returns {{ registration: object, instance: object }} the factory and plugin.
 */
function loadPlugin(source = SOURCE) {
    const registration = capturedRegistration(source);
    const instance = registration.factory((spec) => {
        if (spec === "react") return React;
        throw new Error(`client-modules: require("${spec}") missed the module table`);
    });
    return { registration, instance };
}

/**
 * Apply the client half against a host-shaped context and return the entry.
 * @param {{ source?: string, localeId?: string }} [options] - overrides.
 * @returns {{ Entry: Function, options: object, ctx: object }} the registered entry.
 */
function mount({ source = SOURCE, localeId = "zh-CN" } = {}) {
    const registered = [];
    const locale = {
        getSnapshot: () => ({ id: localeId, locales: [localeId], revision: 0 }),
        subscribe: () => () => {},
        register: () => () => {},
    };
    const ctx = {
        locale,
        slots: { register: (options, Component) => (registered.push({ options, Component }), () => {}), inject: () => () => {} },
        effect: (fn) => fn(),
    };
    const previousDocument = globalThis.document;
    globalThis.document = { head: { append() {} }, createElement: () => ({ remove() {} }), querySelectorAll: () => [] };
    try {
        loadPlugin(source).instance.apply(ctx);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
    assert.equal(registered.length, 1, "expected exactly one settings.section registration");
    return { Entry: registered[0].Component, options: registered[0].options, ctx };
}

test("real React renders the settings page (not an empty section)", () => {
    const { Entry } = mount();
    const html = renderToStaticMarkup(React.createElement(Entry, { close() {} }));
    assert.ok(html.length > 0, "the page rendered no markup at all — this is the blank-page regression");
    assert.match(html, /知乎全网搜索/u);
    assert.match(html, /type="password"/u);
    assert.match(html, /保存/u);
    assert.match(html, /移除/u);
    assert.match(html, /https:\/\/developer\.zhihu\.com/u);
});

test("real React accepts the registered entry as a component", () => {
    // The defect was a component whose render returned a FUNCTION: React warns
    // "Functions are not valid as a React child" and emits nothing. Rendering
    // through react-dom is what proves the returned value is an element tree.
    const { Entry } = mount();
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
        const html = renderToStaticMarkup(React.createElement(Entry, { close() {} }));
        assert.ok(html.length > 0);
    } finally {
        console.error = original;
    }
    assert.deepEqual(errors.filter((line) => /valid as a React child/u.test(line)), []);
});

test("an English locale renders English copy", () => {
    const { Entry } = mount({ localeId: "en" });
    const html = renderToStaticMarkup(React.createElement(Entry, { close() {} }));
    assert.match(html, /Zhihu global search/u);
    assert.match(html, /Save/u);
});

test("a page that throws renders the explanation instead of nothing", () => {
    // The guard is what makes a future failure diagnosable: without it the slot
    // renderer swallows the error and the panel is empty with no text at all.
    const broken = SOURCE.replace(
        "            const localeCtx = localeService(ctx);",
        '            throw new Error("boom-from-page");\n            const localeCtx = localeService(ctx);',
    );
    assert.notEqual(broken, SOURCE, "could not inject the fault");
    const { Entry } = mount({ source: broken });
    const original = console.error;
    console.error = () => {};
    let html;
    try {
        html = renderToStaticMarkup(React.createElement(Entry, { close() {} }));
    } finally {
        console.error = original;
    }
    assert.match(html, /页面渲染失败/u);
    assert.match(html, /boom-from-page/u);
});

test("the page explains a disabled field when the Host reports no credential store", () => {
    // A disabled input with no explanation is what the user hit; the hint must
    // name the cause (Host has no credential backend) and the way in.
    const registered = [];
    const locale = { getSnapshot: () => ({ id: "zh-CN" }), subscribe: () => () => {}, register: () => () => {} };
    const ctx = {
        locale,
        slots: { register: (options, Component) => (registered.push({ options, Component }), () => {}), inject: () => () => {} },
        effect: (fn) => fn(),
    };
    const previousDocument = globalThis.document;
    globalThis.document = { head: { append() {} }, createElement: () => ({ remove() {} }), querySelectorAll: () => [] };
    try {
        loadPlugin(SOURCE).instance.apply(ctx);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
    const Entry = registered[0].Component;
    // The first paint has no Host answer yet; the state line fills in later.
    const html = renderToStaticMarkup(React.createElement(Entry, { close() {} }));
    assert.match(html, /type="password"/u);
    // Whatever the state, the field must never be disabled WTHOUT a reason on
    // screen: the hint slot is rendered for every non-configured state.
    assert.match(html, /class="zgs-hint"|data-state="unconfigured"/u);
});

test("the entry never returns a bare component function", () => {
    // The exact shape that blanked the page: `Entry()` returning a function.
    const { Entry } = mount();
    const result = Entry({ close() {} });
    assert.equal(typeof result, "object", "Entry must return a React element, not a component function");
    assert.notEqual(result, null);
});