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

test("peer dependencies are host-provided and match the shipped runtime", () => {
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-tools"]) {
        assert.ok(manifest.peerDependencies?.[name], `missing peer ${name}`);
    }
    assert.equal(manifest.dependencies, undefined, "the plugin must not duplicate host packages");
    // The plugin registers no skill, so it must not depend on the skill registry.
    assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-skill"], undefined);
    assert.equal(manifest.devDependencies["@deepseek-ai/dsh-skill"], undefined);
});
