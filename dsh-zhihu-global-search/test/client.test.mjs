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
 * A locale service shaped exactly like the shipped one (LocaleFace).
 * @param {string} id - the active language id.
 * @returns {object} the stub.
 */
function realLocaleService(id) {
    return {
        getSnapshot: () => ({ id, locales: [id], revision: 0 }),
        subscribe: () => () => {},
        register: () => () => {},
    };
}

/**
 * A service that throws on any unknown property, like a real Cordis service
 * object (whose service proxy rejects missing members).
 * @param {object} members - the implemented members.
 * @returns {Proxy} the strict service.
 */
function strictService(members) {
    return new Proxy(members, {
        get(object, property) {
            if (property in object) return object[property];
            if (typeof property !== "string") return undefined;
            throw new TypeError(`this.locale.${property} is not a function`);
        },
    });
}

/**
 * The React stand-in handed to the factory.
 *
 * Hooks are GLOBAL slots, exactly like React's dispatcher: `Component()` runs
 * outside the current call stack, so a per-render closure would be lost. Each
 * render test resets the slots synchronously before calling the component.
 */

const hooks = {
    /** @type {Array<{ value: unknown }>} */
    cells: [],
    index: 0,
    /** @type {Function[]} */
    pending: [],
    /**
     * Start a fresh render pass. The hook cells persist (a re-render keeps its
     * state); only the index and the effect queue restart, like a React mount.
     */
    startPass() {
        this.index = 0;
        this.pending = [];
    },
    /** Forget every cell: a different component instance (the preview render). */
    newInstance() {
        this.cells = [];
        this.startPass();
    },
    useState(initial) {
        const cell = (this.cells[this.index] ??= { value: typeof initial === "function" ? initial() : initial });
        this.index += 1;
        return [
            cell.value,
            (next) => {
                cell.value = typeof next === "function" ? next(cell.value) : next;
            },
        ];
    },
    useEffect(effect) {
        this.pending.push(effect);
        this.index += 1;
    },
    useRef(initial) {
        const cell = (this.cells[this.index] ??= { value: { current: initial } });
        this.index += 1;
        return cell.value;
    },
    useCallback(callback) {
        this.index += 1;
        return callback;
    },
    /** Run the effects queued by the last render. */
    runEffects() {
        for (const effect of this.pending.splice(0)) effect();
    },
};

/**
 * A minimal class-component base, like `React.Component`: framework code that
 * uses an error boundary needs it, and a stub without it is not React-shaped.
 */
class ShimComponent {
    constructor(props) {
        this.props = props;
    }
}

const ReactShim = {
    Component: ShimComponent,
    createElement: (type, props, ...children) => {
        // Render function components eagerly; a class component is rendered
        // through `render()`, which is what React itself does.
        if (typeof type === "function") {
            if (type.prototype?.isReactComponent === undefined && type.prototype?.render === undefined) return type(props);
            const instance = new type(props);
            instance.props = props;
            return type.prototype.render.call(instance);
        }
        return { type, props: { ...props, children } };
    },
    useState: (initial) => hooks.useState(initial),
    useEffect: (effect) => hooks.useEffect(effect),
    useRef: (initial) => hooks.useRef(initial),
    useCallback: (callback) => hooks.useCallback(callback),
};

/**
 * Run the client factory with the given `require` and a minimal host.
 * @param {(spec: string) => unknown} require - the module resolver.
 * @param {{ locale?: object }} [options] - service overrides.
 * @returns {{ ctx: object, registered: { options: object, Component: Function }[], registry: object }} the fake host.
 */
function bootClient(requireFn, options = {}) {
    const registration = capturedRegistration(SOURCE);
    const registered = [];
    const styles = [];
    // The real service is the slot system's LocaleFace: `getSnapshot()` +
    // `subscribe()` + `register()`. It has NO `getLocale()`.
    const locale = options.locale ?? realLocaleService("zh-CN");
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
        const instance = registration.factory((spec) => (spec === "react" ? ReactShim : requireFn(spec)));
        instance.inject = instance.inject ?? ctx.inject;
        instance.apply(ctx);
        // The shell renders the registered component; a component that throws
        // blanks the section without failing registration, so render it here.
        // The registered component is NOT rendered here: the hand-written hook
        // stub is more permissive than React (it happily renders a returned
        // function, which React refuses), so rendering proofs live in
        // test/client-render.test.mjs with real react-dom. This file asserts the
        // registration contract only.
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
    const { registered } = bootClient(seedRequire(PLATFORM_SEEDS, { react: ReactShim }), { locale: realLocaleService("en") });
    assert.equal(registered[0].options.label(), "Zhihu global search");
});

test("the label survives a locale service whose snapshot changes between reads", () => {
    let active = "zh-CN";
    const locale = strictService({
        getSnapshot: () => ({ id: active, locales: ["zh-CN", "en"], revision: active === "zh-CN" ? 0 : 1 }),
        subscribe: (listener) => {
            listeners.push(listener);
            return () => {};
        },
        register: () => () => {},
    });
    const listeners = [];
    const { registered } = bootClient(seedRequire(PLATFORM_SEEDS, { react: ReactShim }), { locale });
    assert.equal(registered[0].options.label(), "知乎全网搜索");
    active = "en";
    for (const listener of listeners) listener();
    assert.equal(registered[0].options.label(), "Zhihu global search");
});

test("a host without the locale service still mounts the page", () => {
    // `{}` is what an older host without `locale` behaves like: no members.
    const { registered } = bootClient(seedRequire(PLATFORM_SEEDS, { react: ReactShim }), { locale: {} });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].options.label(), "知乎全网搜索");
});

test("a strict service without getLocale does not break the label", () => {
    // The regression: calling a member the service does not have throws, and the
    // shell drops the whole section. The label must never reach for one.
    const { registered } = bootClient(seedRequire(PLATFORM_SEEDS, { react: ReactShim }), {
        locale: strictService(realLocaleService("zh-CN")),
    });
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
