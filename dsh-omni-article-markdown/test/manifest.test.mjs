import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const patch = await readFile(new URL("cordis.patch.yml", root), "utf8");

/**
 * Mirror of dsh's `unmetRequirements` (app-boot): an own `engines.dsh` range
 * decides alone; otherwise every `@deepseek-ai/dsh*` peer must match. Plain
 * semver is not a dependency here, so this asserts the shape the host needs,
 * not the full range grammar (see the engines test for range behavior).
 */
test("engines.dsh is the only dsh requirement gate", () => {
    assert.equal(typeof manifest.engines?.dsh, "string");
    // A bare `>=0.2.1` never matches a prerelease such as 0.2.2-rc.1, which made
    // dsh skip this bundle entirely; the range must name prerelease anchors.
    assert.match(manifest.engines.dsh, /-0\b/u, "range must include a prerelease anchor (e.g. >=0.2.2-0)");
    assert.ok(!manifest.engines.dsh.includes("workspace:"), "workspace: ranges are unmet for engines.dsh");
});

test("the bundle points at an existing patch file and a loadable entry", () => {
    assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.main, "index.mjs");
    assert.ok(manifest.files.includes("index.mjs"));
    assert.ok(manifest.files.includes("src"));
    assert.ok(manifest.files.includes("cordis.patch.yml"));
    assert.ok(!manifest.files.some((entry) => /skill/i.test(entry)), "no skill asset may ship");
});

test("the patch registers exactly one row named after the package", () => {
    const rows = [...patch.matchAll(/^\s*- id: (\S+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(rows, ["omni-article-markdown"]);
    assert.ok(patch.includes(`name: ${manifest.name}`), "row must load this package");
    // The README documents overriding config per key; restating it here would
    // couple the bundle to machine-specific paths.
    assert.ok(!/^\s+command: /mu.test(patch), "the bundle must not pin a machine-specific mdcli path");
});

/**
 * Plugin Manager reads `meta.title` / `meta.description` from exported locale
 * JSON without activating the bundle. That text is display-only: the model never
 * sees it, so it may be longer and more salesy than the tool description and
 * must not be conflated with it.
 */
test("display metadata ships as exported locale JSON with an icon", async () => {
    assert.ok(manifest.exports["./locale/*.json"], "locale files must be exported for Plugin Manager");
    assert.ok(manifest.exports["./icon"], "the icon must be exported as ./icon");
    assert.ok(manifest.files.includes("locale/*.json"), "locale files must ship in the tarball");
    assert.ok(manifest.files.includes("icon.svg"), "the icon must ship in the tarball");

    for (const language of ["en", "zh"]) {
        const raw = await readFile(new URL(`locale/${language}.json`, root), "utf8");
        const { meta } = JSON.parse(raw);
        assert.ok(meta?.title?.trim(), `${language}.json needs meta.title`);
        assert.ok(meta?.description?.trim(), `${language}.json needs meta.description`);
        assert.equal(meta.detail, undefined, "no detail document is declared, so the README stays the fallback");
    }

    const zh = JSON.parse(await readFile(new URL("locale/zh.json", root), "utf8"));
    assert.match(zh.meta.title, /墨探/u, "the Chinese row keeps the product name the user recognizes");
    // Model-facing wording belongs in the tool declaration, not here: no
    // parameter plumbing and no routing instructions aimed at the model.
    assert.doesNotMatch(zh.meta.description, /max_tokens|raw_html|no_verify_ssl|truncate/u, "no parameter internals");
    assert.doesNotMatch(zh.meta.description, /you must|must call|do not call/ui, "no model instructions");
    assert.ok(!/[<>&]/u.test(zh.meta.description), "display copy is plain text, not markup");
});

test("peer dependencies are host-provided and match the shipped runtime", () => {
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-tools"]) {
        assert.ok(manifest.peerDependencies?.[name], `missing peer ${name}`);
    }
    assert.equal(manifest.dependencies, undefined, "the plugin must not duplicate host packages");
    // The plugin registers no skill, so it must not depend on the skill registry.
    assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-skill"], undefined);
    assert.equal(manifest.devDependencies["@deepseek-ai/dsh-skill"], undefined);
});
