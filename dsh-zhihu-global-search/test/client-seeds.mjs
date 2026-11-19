/**
 * What a static `dsh.client` bundle may require, checked against the module
 * table the host actually serves.
 *
 * The browser module system resolves `require(spec)` in three steps: a platform
 * SEED, an already-materialized module, then a registered package factory.
 * Anything else throws `missed the module table`, which fails that client entry's
 * import and — because the entry is `immediately: true` — surfaces as a boot
 * error for every session. `locale`, `host` and `styles` are NOT in the table.
 *
 * The list below is read from the installed `@deepseek-ai/dsh-web-frontend`
 * build (the `staticModules` argument of `window.__ModuleLoader__.create`) and
 * is checked by `test/manifest.test.mjs`: when a release adds a seed, the
 * constant and the installed bundle disagree and the test says so.
 *
 * @module dsh-zhihu-global-search/test/client-seeds
 */

/**
 * Platform seed module names for the release this plugin targets (0.2.2-rc.5).
 * @type {readonly string[]}
 */
export const PLATFORM_SEEDS = Object.freeze([
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "@deepseek-ai/cordis",
    "zod",
    "@tanstack/react-virtual",
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-dockkit",
]);

/**
 * Strip comments before reading code.
 *
 * Doc comments legitimately mention `require("host")` while explaining why it
 * is wrong; scanning raw text would report those as violations.
 * @param {string} source - JavaScript source.
 * @returns {string} the source with `//` and block comments removed.
 */
export function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

/**
 * Every module name the client half requires at runtime.
 * @param {string} source - `client.js` source.
 * @returns {string[]} required specifiers, in source order.
 */
export function requiredModules(source) {
    const code = stripComments(source);
    const found = [];
    for (const match of code.matchAll(/\brequire\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/gu)) {
        found.push(match[1] ?? match[2]);
    }
    return found;
}

/**
 * The loads the browser entry returns; the factory body is plain JS we can run
 * in a VM with a recording `require`.
 * @param {string} source - `client.js` source.
 * @returns {{ id: string, loads: Array<{ id: string, factory: Function }> }} the registration.
 */
export function capturedRegistration(source) {
    let registration;
    const window = {
        __ModuleLoader__: {
            load: (load) => {
                registration = load;
            },
        },
    };
    // `new Function` keeps this dependency-free; the source is our own file. Do
    // NOT pass a `document` parameter: a named parameter of `undefined` would
    // shadow `globalThis.document` inside the factory and make every
    // `typeof document` check in the client read "undefined".
    const run = new Function("window", `${source}\n`);
    run(window);
    if (registration === undefined) throw new Error("client.js did not call window.__ModuleLoader__.load()");
    return registration;
}

/**
 * Build a `require` that behaves like the browser module system: seeds and
 * declared stubs resolve, everything else throws the real error text.
 * @param {string[]} seeds - available module names.
 * @param {Record<string, unknown>} [stubs] - extra materialized modules.
 * @returns {(spec: string) => unknown} the require.
 */
export function seedRequire(seeds, stubs = {}) {
    const table = new Map(seeds.map((name) => [name, minimalModule(name)]));
    for (const [name, value] of Object.entries(stubs)) table.set(name, value);
    return (spec) => {
        if (table.has(spec)) return table.get(spec);
        throw new Error(
            `client-modules: require("${spec}") missed the module table — not a platform seed word, ` +
                "not a materialized module, and no registered package factory (a build-time externals drift, " +
                "or a dynamic dependency that did not arrive)",
        );
    };
}

/**
 * Just enough of each seed for the factory to run.
 * @param {string} name - seed module name.
 * @returns {unknown} the stub.
 */
function minimalModule(name) {
    if (name === "react") {
        const createElement = () => ({});
        return { createElement, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({}) };
    }
    return {};
}