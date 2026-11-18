import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DELETE_ERROR_CODES } from "../src/errors.mjs";
import { HOST_TEXT, stringsFor, translate } from "../src/i18n.mjs";
import { DELETE_ROUTE, DEFAULTS, resolveConfig } from "../index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read one project file as UTF-8.
 * @param {string} relative - path relative to the plugin root.
 * @returns {Promise<string>} the file contents.
 */
const read = (relative) => readFile(path.join(ROOT, relative), "utf8");

/**
 * Read one project file as parsed JSON.
 * @param {string} relative - path relative to the plugin root.
 * @returns {Promise<any>} the parsed document.
 */
const readJson = async (relative) => JSON.parse(await read(relative));

test("the package manifest declares the bundle, the client half, and every runtime file", async () => {
    const manifest = await readJson("package.json");
    assert.equal(manifest.name, "dsh-session-delete");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.main, "index.mjs");
    assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
    assert.deepEqual(manifest.dsh.client, { platform: "web", immediately: true });
    assert.equal(manifest.dsh.tools, undefined, "this plugin registers no native tool");

    // A plain `>=0.2.1` range does NOT match a `0.2.2-rc.N` prerelease, and dsh
    // silently skips a bundle that fails the gate. The range must be pre-release
    // anchored on both sides.
    assert.match(manifest.engines.dsh, /^>0\.2\.0-0 <0\.2\.2 \|\| >=0\.2\.2-0 <0\.3\.0$/);
    assert.match(manifest.engines.node, />=22\.19\.0/);

    for (const entry of [".", "./client", "./cordis.patch.yml", "./locale/*.json", "./icon"]) {
        assert.ok(manifest.exports[entry], `exports["${entry}"]`);
    }
    for (const entry of ["index.mjs", "client.js", "src", "locale/*.json", "icon.svg", "cordis.patch.yml"]) {
        assert.ok(manifest.files.includes(entry), `files includes "${entry}"`);
    }
    assert.deepEqual(Object.keys(manifest.peerDependencies), ["@deepseek-ai/cordis"], "zero runtime dependencies");
});

test("every runtime module the manifest promises exists", async () => {
    const manifest = await readJson("package.json");
    for (const relative of [manifest.main, manifest.exports["./client"], manifest.exports["./cordis.patch.yml"], manifest.exports["./icon"]]) {
        const info = await stat(path.join(ROOT, relative));
        assert.equal(info.isFile(), true, relative);
    }
});

test("the patch inserts exactly one row with an id and a name", async () => {
    const patch = await read("cordis.patch.yml");
    const body = patch
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
        .trim();
    assert.equal(
        body,
        ["- insert:", "    - id: session-delete", "      name: dsh-session-delete"].join("\n"),
        "the patch must not inline a config block (a matching override replaces the whole config)",
    );
});

test("both display locales carry a title and a description", async () => {
    for (const locale of ["zh", "en"]) {
        const meta = await readJson(`locale/${locale}.json`);
        assert.equal(typeof meta.meta.title, "string");
        assert.equal(typeof meta.meta.description, "string");
        assert.ok(meta.meta.title.length > 0 && meta.meta.title.length <= 120, locale);
        assert.ok(meta.meta.description.length > 0, locale);
    }
    const zh = await readJson("locale/zh.json");
    const en = await readJson("locale/en.json");
    assert.notEqual(zh.meta.title, en.meta.title);
});

test("the icon is a small, self-contained SVG", async () => {
    const icon = await read("icon.svg");
    assert.match(icon.trimStart(), /^<svg /);
    const info = await stat(path.join(ROOT, "icon.svg"));
    assert.ok(info.size < 256 * 1024, "icons must stay below 256 KiB");
    // The only URL a self-contained icon may carry is the SVG namespace.
    const urls = icon.match(/https?:\/\/[^"\'\s>]+/g) ?? [];
    assert.deepEqual(urls, ["http://www.w3.org/2000/svg"], "no remote resources");
    assert.doesNotMatch(icon, /<script|xlink:href/, "no scripts or external references");
});

test("the client half registers the bottom Session menu entry through the slot API", async () => {
    const client = await read("client.js");
    assert.match(client, /window\.__ModuleLoader__\.load\(/);
    assert.match(client, /id:\s*"dsh-session-delete"/);
    assert.match(client, /inject:\s*\["slots"\]/);
    assert.match(client, /ctx\.slots\.inject\("sidebar\.workspaces\.session\.menu\.item"/);
    assert.match(client, /order:\s*1000/, "the entry must sort after the built-in entries");
    assert.match(client, /fetch\(DELETE_URL/, "the browser half talks to the Host route");
    assert.match(client, /api\/dsh-session-delete\/delete/);
    assert.doesNotMatch(client, /require\("host"\)|require\('host'\)/, "a static bundle has no host module");
    assert.doesNotMatch(client, /document\.body|appendChild|querySelector|MutationObserver/, "no DOM manipulation outside React");
    // Colors must come from the host theme; a token fallback is the only
    // permitted literal (it covers a token missing from an older host).
    const literals = client.match(/color:\s*#[0-9a-fA-F]{3,8}/g) ?? [];
    assert.deepEqual(literals, [], "colors must be theme tokens");
});

test("the client route matches the Host route", async () => {
    const client = await read("client.js");
    const match = client.match(/const DELETE_URL = "([^"]+)"/);
    assert.ok(match, "DELETE_URL is declared");
    assert.equal(`/${match[1]}`, DELETE_ROUTE);
});

test("the Host dictionaries stay key-for-key in sync", () => {
    const zh = Object.keys(HOST_TEXT["zh-CN"]).sort();
    const en = Object.keys(HOST_TEXT.en).sort();
    assert.deepEqual(en, zh);
    for (const key of zh) {
        assert.ok(HOST_TEXT["zh-CN"][key].length > 0, key);
        assert.ok(HOST_TEXT.en[key].length > 0, key);
        assert.notEqual(HOST_TEXT["zh-CN"][key], HOST_TEXT.en[key], `${key} is translated`);
    }
});

test("stringsFor defaults to Chinese and honours an English tag", () => {
    assert.equal(stringsFor(undefined), HOST_TEXT["zh-CN"]);
    assert.equal(stringsFor("zh-CN"), HOST_TEXT["zh-CN"]);
    assert.equal(stringsFor("en-US"), HOST_TEXT.en);
    assert.equal(stringsFor(42), HOST_TEXT["zh-CN"]);
    assert.equal(translate(HOST_TEXT.en, "error.session-not-found"), HOST_TEXT.en["error.session-not-found"]);
    assert.equal(translate(HOST_TEXT.en, "missing.key"), "missing.key");
});

test("the documented defaults are what resolveConfig produces", () => {
    assert.deepEqual(resolveConfig(), { ...DEFAULTS });
    assert.equal(DEFAULTS.allowDeleteRunning, true);
    assert.equal(DEFAULTS.deleteProjectionCache, true);
    assert.equal(DEFAULTS.stopTimeoutMs, 8000);
});