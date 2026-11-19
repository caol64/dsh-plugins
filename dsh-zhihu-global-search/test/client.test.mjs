/**
 * The Client half, exercised the way the browser module system loads it.
 *
 * The regression this file guards: `client.js` used to `require("locale")`,
 * `require("host")` and `require("styles")`, and every one of those throws
 * `missed the module table` in the browser, so the whole client half — and, for
 * an `immediately: true` entry, the web boot — failed. The factory is therefore
 * run here with a `require` that resolves ONLY the platform seeds and throws the
 * real error text otherwise, which makes a re-introduced bare module fail the
 * test exactly as it fails the browser.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capturedRegistration, PLATFORM_SEEDS, requiredModules, seedRequire, stripComments } from "./client-seeds.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const SOURCE = readFileSync(path.join(ROOT, "client.js"), "utf8");

/** The factory never runs this long outside a test. */
const BOOT_TIMEOUT_MS = 200;

/**
 * Run the client factory with the given `require` and a minimal host.
 * @param {(spec: string) => unknown} require - the module resolver.
 * @param {{ locale?: object }} [options] - service overrides.
 * @returns {{ ctx: object, registered: object[], registry: object }} the fake host.
 */
function bootClient(requireFn, options = {}) {
    const registration = capturedRegistration(SOURCE);
    const registered = [];
    const styles = [];
    const locale = options.locale ?? {
        getLocale: () => ({ id: "zh-CN" }),
        subscribe: () => () => {},
        register: () => () => {},
    };
    const ctx = {
        inject: ["slots", "locale"],
        get: (key) => (key === "locale" ? locale : undefined),
        locale,
        slots: {
            register: (options_, Component) => {
                registered.push({ options: options_, Component });
                return () => {};
            },
            inject: () => () => {},
        },
        effect: (fn) => {
            const dispose = fn();
            return typeof dispose === "function" ? dispose : () => {};
        },
    };
    // A host-shaped `document` so the stylesheet helper can run.
    const previousDocument = globalThis.document;
    globalThis.document = {
        head: { append: (element) => styles.push(element) },
        createElement: () => ({
            textContent: "",
            remove() {
                this.removed = true;
            },
        }),
        querySelectorAll: () => [],
    };
    try {
        const instance = registration.factory(requireFn);
        instance.inject = instance.inject ?? ctx.inject;
        instance.apply(ctx);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
    return { ctx, registered, registry: { styles, registration } };
}

test("the factory id is the package name", () => {
    assert.equal(capturedRegistration(SOURCE).id, "dsh-zhihu-global-search");
});

test("the client half requires only platform seeds", () => {
    const modules = requiredModules(SOURCE);
    assert.ok(modules.length > 0, "expected at least one require");
    for (const name of modules) assert.ok(PLATFORM_SEEDS.includes(name), `${name} is not a platform seed`);
    assert.deepEqual(modules, ["react"]);
});

test("require() appears only as code, never in the doc comments that explain the rule", () => {
    const code = stripComments(SOURCE);
    assert.equal(requiredModules(SOURCE).length, [...code.matchAll(/\brequire\(/gu)].length);
    // The comments still carry the explanation, which is the point.
    assert.match(SOURCE, /There is no `host`, no `styles` and no `locale` module/u);
    assert.match(SOURCE, /`missed the module table`/u);
});

test("the factory loads with only the platform seeds available", () => {
    const { registered, registry } = bootClient(seedRequire(PLATFORM_SEEDS));
    assert.equal(registered.length, 1, "expected exactly one slot registration");
    assert.equal(registered[0].options.name, "settings.section");
    assert.equal(registered[0].options.id, "zhihu-global-search");
    assert.equal(registered[0].options.order, 25);
    assert.equal(typeof registered[0].options.label, "function");
    assert.equal(registered[0].options.label(), "知乎全网搜索");
    assert.equal(registry.styles.length, 1);
    assert.match(registry.styles[0].textContent, /--dsw-alias-/u);
});

test("the locale service is a service (injected), so the label follows the app language", () => {
    const english = { getLocale: () => ({ id: "en-US" }), subscribe: () => () => {}, register: () => () => {} };
    const { registered } = bootClient(seedRequire(PLATFORM_SEEDS), { locale: english });
    assert.equal(registered[0].options.label(), "Zhihu global search");
});

test("a host without the locale service still mounts the page", () => {
    const { registered } = bootClient(seedRequire(PLATFORM_SEEDS), { locale: {} });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].options.label(), "知乎全网搜索");
});

test("a bare `require(\"locale\")` fails exactly as the browser would", () => {
    // This is the regression itself: prove the harness can see it. Each of the
    // three modules the client half used to require is put back, one at a time.
    for (const spec of ["locale", "host", "styles"]) {
        const broken = SOURCE.replace(
            'const React = require("react");',
            `const React = require("react");\n        const extra = require("${spec}");`,
        );
        assert.notEqual(broken, SOURCE, `could not inject a ${spec} require`);
        const registration = capturedRegistration(broken);
        assert.throws(
            () => registration.factory(seedRequire(PLATFORM_SEEDS)),
            new RegExp(`require\\("${spec}"\\) missed the module table`, "u"),
            spec,
        );
    }
});

test("the settings page calls the Host's exact fetch route", () => {
    assert.match(SOURCE, /fetch\(SETTINGS_URL/u);
    assert.match(SOURCE, /api\/dsh-zhihu-global-search\/settings/u);
    // No client-side RPC surface, which the browser cannot reach anyway.
    assert.equal(stripComments(SOURCE).includes("remote.credentials"), false);
});
test("the installed web frontend's seed table matches the constant (drift guard)", () => {
    const bundle = locateInstalledFrontend();
    if (bundle === null) {
        // Report, never silently pass: this guard only runs where a harness
        // installation (or a plugin-local copy) is visible.
        console.warn("seed drift guard skipped: no installed @deepseek-ai/dsh-web-frontend found");
        return;
    }
    const seeds = seedsFromFrontendForTest(bundle);
    assert.notEqual(seeds, undefined, `could not read staticModules from ${bundle}; update seedsFromFrontendForTest()`);
    assert.deepEqual(seeds, [...PLATFORM_SEEDS], `installed frontend ${bundle} serves a different seed table`);
});

/**
 * Locate the installed web frontend's main bundle.
 *
 * Resolution order: the plugin's own node_modules, then the harness global
 * store under `~/Library/pnpm/global/5/.pnpm` (a developer machine), then
 * `/root/.cache`-style none. Reading is read-only and best effort.
 * @returns {string | null} the bundle path, or null when not found.
 */
function locateInstalledFrontend() {
    const { homedir } = os;
    const pluginLocal = path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-web-frontend");
    const globalStore = path.join(homedir(), "Library", "pnpm", "global", "5", ".pnpm");
    const candidates = [pluginLocal];
    if (existsSync(globalStore)) {
        for (const entry of readdirSync(globalStore)) {
            if (entry.startsWith("@deepseek-ai+dsh-web-frontend@")) {
                candidates.push(path.join(globalStore, entry, "node_modules", "@deepseek-ai", "dsh-web-frontend"));
            }
        }
    }
    for (const root of candidates) {
        const index = path.join(root, "dist", "index.html");
        if (!existsSync(index)) continue;
        const assets = readdirSync(path.join(root, "dist", "assets")).filter((name) => /^index-.*\.js$/u.test(name));
        if (assets.length === 0) continue;
        // Newest first: several installs coexist across releases.
        assets.sort();
        return path.join(root, "dist", "assets", assets[assets.length - 1]);
    }
    return null;
}

/**
 * Read the seed table out of the built frontend.
 * @param {string} bundle - bundle path.
 * @returns {string[] | undefined} seed names.
 */
function seedsFromFrontendForTest(bundle) {
    const source = readFileSync(bundle, "utf8");
    const call = source.indexOf("staticModules:");
    if (call < 0) return undefined;
    const factory = /staticModules:\s*([A-Za-z_$][\w$]*)\(\)/u.exec(source.slice(call));
    if (factory === null) return undefined;
    const name = factory[1].replace(/\$/gu, "\\$");
    const body = new RegExp(`function ${name}\\(\\)\\s*\\{\\s*return\\s*\\{([\\s\\S]*?)\\}\\s*\\}`, "u").exec(source);
    if (body === null) return undefined;
    return [...body[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))(?=\s*:)/gu)]
        .map((match) => match[1] ?? match[2])
        .filter(Boolean);
}
