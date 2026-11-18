import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");

/** Files the installed package must carry to work at runtime. */
const RUNTIME_FILES = [
    "index.mjs",
    "client.js",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "icon.svg",
    "src/credentials.mjs",
    "src/endpoint.mjs",
    "src/errors.mjs",
    "src/respond.mjs",
    "src/result.mjs",
    "src/search.mjs",
    "src/settings.mjs",
    "src/tool.mjs",
];

test("the manifest identifies a bundle with a patch and a web client half", () => {
    assert.equal(manifest.name, "dsh-zhihu-global-search");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.main, "index.mjs");
    assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
    assert.equal(manifest.dsh.client.platform, "web");
    assert.equal(manifest.dsh.client.immediately, true);
});

test("the dsh engine range carries a prerelease anchor", () => {
    // A plain `>=0.2.1` never matches `0.2.2-rc.1`, and dsh then skips the
    // bundle SILENTLY — the plugin looks installed but never activates.
    assert.match(manifest.engines.dsh, /^>0\.2\.0-0 </u);
    assert.match(manifest.engines.dsh, /\|\| >=0\.2\.2-0 /u);
});

test("the plugin declares no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.optionalDependencies, undefined);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), [
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-tools",
    ]);
});

test("the patched row names only id and name", () => {
    // A row that restates config in the bundle patch would be replaced wholesale
    // by any user override, silently resetting the other keys.
    assert.match(patch, /- insert:\n {4}- id: zhihu-global-search\n {6}name: dsh-zhihu-global-search\s*$/u);
    assert.doesNotMatch(patch, /^\s+config:/mu);
});

test("every runtime file is shipped by the files whitelist", () => {
    const shipped = new Set(manifest.files);
    for (const file of RUNTIME_FILES) {
        if (shipped.has(file)) continue;
        assert.ok(shipped.has(file.split("/")[0]), `${file} is not covered by files`);
    }
    assert.equal(shipped.has("client.js"), true);
    assert.equal(shipped.has("test"), false);
    assert.equal(shipped.has("scripts"), false);
});

test("the exports expose both halves, the patch, the locales and the icon", () => {
    const exports = manifest.exports;
    assert.equal(exports["."], "./index.mjs");
    assert.equal(exports["./client"], "./client.js");
    assert.equal(exports["./cordis.patch.yml"], "./cordis.patch.yml");
    assert.equal(exports["./locale/*.json"], "./locale/*.json");
    assert.equal(exports["./icon"], "./icon.svg");
    assert.equal(exports["./package.json"], "./package.json");
});

test("the display metadata exists in Chinese and English", () => {
    for (const locale of ["zh", "en"]) {
        const meta = JSON.parse(readFileSync(join(root, "locale", `${locale}.json`), "utf8")).meta;
        assert.equal(typeof meta.title, "string", locale);
        assert.ok(meta.title.length > 0, locale);
        assert.equal(typeof meta.description, "string", locale);
        assert.ok(meta.description.length > 0, locale);
    }
    const icon = readFileSync(join(root, "icon.svg"), "utf8");
    assert.match(icon, /^<svg[\s>]/u);
    assert.ok(Buffer.byteLength(icon) < 256 * 1024);
});

test("the host and client halves are syntactically valid JavaScript", () => {
    for (const file of ["index.mjs", "client.js"]) {
        assert.doesNotThrow(
            () => execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" }),
            file,
        );
    }
});

test("the client half registers a lazy factory under the package name", () => {
    const source = readFileSync(join(root, "client.js"), "utf8");
    // Dynamic-client convention: the factory id is the package name and the
    // module table provides React, the RPC bridge, styles and the context.
    assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-zhihu-global-search"/u);
    for (const builtin of ['require("react")', 'require("host")', 'require("styles")', 'require("locale")']) {
        assert.ok(source.includes(builtin), builtin);
    }
    assert.match(source, /"settings\.section"/u);
    // Visible text is routed through the locale service, not hard-coded JSX.
    assert.match(source, /localeCtx\.register\(NS, DICTS\)/u);
    // The page must not import a Harness client package: those change without
    // notice and an import failure blanks the slot entry.
    assert.doesNotMatch(source, /@deepseek-ai\/dsh-client-/u);
    // Styles come from theme tokens; literal colors are allowed only as the
    // var() fallback that keeps an unknown-token host readable.
    const css = source.slice(source.indexOf("const CSS"), source.indexOf("const CSS") + 6000);
    assert.match(css, /--dsw-alias-/u);
    const literals = [...css.matchAll(/(^|[^-\w])(#[0-9a-fA-F]{3,8})\b/gu)].map((match) => match[2]);
    assert.ok(literals.length > 0, "expected fallback colors");
    for (const literal of literals) {
        const uses = [...css.matchAll(new RegExp(`var\\([^)]*${literal}[^)]*\\)`, "gu"))];
        assert.ok(uses.length > 0, `color ${literal} is used outside a var() fallback`);
    }
});

test("the client half never stores a secret beyond the password field", () => {
    const source = readFileSync(join(root, "client.js"), "utf8");
    // The only credentialed RPC calls are the host-side ones; the browser never
    // touches remote.credentials (which would name the reference from the page).
    assert.doesNotMatch(source, /remote\.credentials/u);
    assert.match(source, /type: "password"/u);
    // The draft is cleared once a write settles, in both outcomes.
    assert.equal((source.match(/setDraft\(""\)/gu) ?? []).length >= 2, true);
});