import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareVersions, createProbeCache, parseVersion, probeMdcli, supportsTruncate } from "../src/env.mjs";

test("parseVersion reads the mdcli banner", () => {
    assert.deepEqual(parseVersion("mdcli, version 0.2.4"), [0, 2, 4]);
    assert.deepEqual(parseVersion("1.10.20\n"), [1, 10, 20]);
    assert.equal(parseVersion("no version here"), null);
});

test("compareVersions orders numerically, not lexically", () => {
    assert.equal(compareVersions([0, 2, 10], [0, 2, 9]), 1);
    assert.equal(compareVersions([0, 2, 4], [0, 2, 4]), 0);
    assert.equal(compareVersions([0, 1, 9], [0, 2, 0]), -1);
});

test("supportsTruncate requires 0.2.4 or newer", () => {
    assert.equal(supportsTruncate({ installed: true, versionParts: [0, 2, 4] }), true);
    assert.equal(supportsTruncate({ installed: true, versionParts: [0, 3, 0] }), true);
    assert.equal(supportsTruncate({ installed: true, versionParts: [0, 2, 3] }), false);
    assert.equal(supportsTruncate({ installed: true, versionParts: null }), false);
});

test("probeMdcli reports an explicit command with its version", async () => {
    const info = await probeMdcli("./test/fixtures/fake-mdcli.mjs");
    assert.equal(info.installed, true);
    assert.equal(info.version, "0.2.4");
    assert.deepEqual(info.versionParts, [0, 2, 4]);
});

test("probeMdcli reports a missing explicit command without throwing", async () => {
    const info = await probeMdcli("/nonexistent/mdcli");
    assert.equal(info.installed, false);
    assert.equal(info.version, null);
    assert.equal(supportsTruncate(info), false);
});

test("createProbeCache reuses results within the TTL and can be invalidated", async () => {
    let calls = 0;
    const cache = createProbeCache(
        async () => {
            calls += 1;
            return { installed: true, bin: "mdcli", version: "0.2.4", versionParts: [0, 2, 4], error: null };
        },
        { ttlMs: 60_000 },
    );
    await cache.get();
    await cache.get();
    assert.equal(calls, 1);
    cache.invalidate();
    await cache.get();
    assert.equal(calls, 2);
});

test("createProbeCache does not cache a rejection", async () => {
    let calls = 0;
    const cache = createProbeCache(async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { installed: false, bin: "mdcli", version: null, versionParts: null, error: null };
    });
    await assert.rejects(cache.get(), /boom/u);
    const second = await cache.get();
    assert.equal(second.installed, false);
    assert.equal(calls, 2);
});

test("probeMdcli finds a user-tool binary through PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-env-"));
    const bin = join(dir, "mdcli");
    await writeFile(bin, '#!/bin/sh\necho "mdcli, version 0.2.4"\n', { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous ?? ""}`;
    try {
        const info = await probeMdcli("mdcli");
        assert.equal(info.installed, true);
        assert.equal(info.version, "0.2.4");
    } finally {
        process.env.PATH = previous;
    }
});

test("probeMdcli skips a PATH entry that is not executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-env-"));
    const nested = join(dir, "bin");
    await mkdir(nested);
    await writeFile(join(nested, "mdcli"), "not executable\n", { mode: 0o644 });
    const previous = process.env.PATH;
    process.env.PATH = nested;
    try {
        const info = await probeMdcli("mdcli");
        // Fallbacks may still find a real mdcli on the machine; this only asserts
        // that the broken candidate itself is not reported as installed.
        if (info.installed) assert.ok(!info.bin.startsWith(nested), `unexpected binary ${info.bin}`);
    } finally {
        process.env.PATH = previous;
    }
});
