import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DeleteFailure } from "../src/errors.mjs";
import {
    defaultSessionRoot,
    escapeRegExp,
    isSessionId,
    isStrictDescendant,
    projectionCacheLayout,
    resolveOwnedDirectory,
    selectProjectionRecords,
} from "../src/targets.mjs";

/**
 * Create one temporary harness home with a session directory.
 * @param {{ id?: string, project?: string }} [options] - directory layout.
 * @returns {Promise<{ home: string, root: string, directory: string, log: string, cleanup: () => Promise<void> }>} the fixture.
 */
async function sessionHome({ id = "session-alpha", project = "--tmp-project--" } = {}) {
    const home = await mkdtemp(path.join(tmpdir(), "dsh-session-delete-"));
    const root = path.join(home, "sessions");
    const directory = path.join(root, project, id);
    await mkdir(directory, { recursive: true });
    const log = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(log, "");
    return { home, root, directory, log, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("a session id must be one plain path segment", () => {
    for (const id of ["session-1", "session-6caab27d-f091-43d2-a99d-c2a6677a5c57", "a", "A_b.c-d"]) {
        assert.equal(isSessionId(id), true, id);
    }
    for (const id of ["", ".", "..", "../etc", "a/b", "a\\b", "~002E", "-leading", ".hidden", "session 1", "a".repeat(201)]) {
        assert.equal(isSessionId(id), false, id);
    }
    for (const id of [undefined, null, 42, {}, ["session-1"]]) {
        assert.equal(isSessionId(id), false, String(id));
    }
});

test("descendant checks refuse the root itself, siblings, and escapes", () => {
    assert.equal(isStrictDescendant("/a/sessions", "/a/sessions/p/s"), true);
    assert.equal(isStrictDescendant("/a/sessions", "/a/sessions"), false);
    assert.equal(isStrictDescendant("/a/sessions", "/a/sessions-other/p/s"), false);
    assert.equal(isStrictDescendant("/a/sessions", "/a"), false);
    assert.equal(isStrictDescendant("/a/sessions", "/a/sessions/../escape"), false);
});

test("the default session root needs an absolute home", () => {
    assert.equal(defaultSessionRoot("/home/u/.dsh"), path.join("/home/u/.dsh", "sessions"));
    assert.equal(defaultSessionRoot(undefined), undefined);
    assert.equal(defaultSessionRoot("relative/home"), undefined);
});

test("the projection-cache layout matches the record and its backups only", () => {
    const layout = projectionCacheLayout("/home/u/.dsh", "session-alpha");
    assert.ok(layout);
    assert.equal(layout.directory, path.join("/home/u/.dsh", "storages", "session_projcache", "sessions"));
    assert.match("session-alpha.json", layout.recordPattern);
    assert.match("session-alpha.json.bak.20261118", layout.recordPattern);
    assert.doesNotMatch("session-alpha.jsonl", layout.recordPattern);
    assert.doesNotMatch("session-alphabet.json", layout.recordPattern);
    assert.doesNotMatch("session-beta.json", layout.recordPattern);
    assert.equal(projectionCacheLayout(undefined, "session-alpha"), undefined);

    const entries = [
        { name: "session-alpha.json", isFile: () => true, isSymbolicLink: () => false },
        { name: "session-alpha.json.bak.1", isFile: () => true, isSymbolicLink: () => false },
        { name: "session-alphabet.json", isFile: () => true, isSymbolicLink: () => false },
        { name: "session-alpha.json", isFile: () => false, isSymbolicLink: () => false },
    ];
    assert.deepEqual(
        selectProjectionRecords(layout, entries).map((entry) => path.basename(entry)),
        ["session-alpha.json", "session-alpha.json.bak.1"],
    );
});

test("regex escaping keeps a literal id literal", () => {
    assert.equal(escapeRegExp("a.b+c"), "a\\.b\\+c");
    assert.match("a.b+c", new RegExp(`^${escapeRegExp("a.b+c")}$`));
    assert.doesNotMatch("axb+c", new RegExp(`^${escapeRegExp("a.b+c")}$`));
});

test("resolveOwnedDirectory accepts a directory owned by the session", async (t) => {
    const fixture = await sessionHome();
    t.after(fixture.cleanup);
    const owned = await resolveOwnedDirectory({ id: "session-alpha", locationPath: fixture.log, sessionRoot: fixture.root });
    assert.equal(owned.directory, await realpath(fixture.directory));
    assert.equal(owned.logPath, fixture.log);
});

test("resolveOwnedDirectory resolves the root through symlinks too", async (t) => {
    const fixture = await sessionHome();
    t.after(fixture.cleanup);
    const link = path.join(fixture.home, "sessions-link");
    await symlink(fixture.root, link);
    const owned = await resolveOwnedDirectory({ id: "session-alpha", locationPath: fixture.log, sessionRoot: link });
    assert.equal(owned.directory, await realpath(fixture.directory));
});

test("resolveOwnedDirectory refuses an id that is not a plain segment", async (t) => {
    const fixture = await sessionHome();
    t.after(fixture.cleanup);
    await assert.rejects(
        resolveOwnedDirectory({ id: "../alpha", locationPath: fixture.log, sessionRoot: fixture.root }),
        (error) => error instanceof DeleteFailure && error.code === "invalid-id",
    );
});

test("resolveOwnedDirectory refuses a log path outside the session root", async (t) => {
    const fixture = await sessionHome();
    t.after(fixture.cleanup);
    const outside = await mkdtemp(path.join(tmpdir(), "dsh-session-delete-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const foreignDir = path.join(outside, "session-alpha");
    await mkdir(foreignDir, { recursive: true });
    const foreignLog = path.join(foreignDir, "session.v4.jsonl.zstd");
    await writeFile(foreignLog, "");
    await assert.rejects(
        resolveOwnedDirectory({ id: "session-alpha", locationPath: foreignLog, sessionRoot: fixture.root }),
        (error) => error instanceof DeleteFailure && error.code === "denied-path",
    );
});

test("resolveOwnedDirectory refuses a directory whose name is not the session id", async (t) => {
    const fixture = await sessionHome();
    t.after(fixture.cleanup);
    const sibling = path.join(path.dirname(fixture.directory), "session-beta");
    await mkdir(sibling, { recursive: true });
    const log = path.join(sibling, "session.v4.jsonl.zstd");
    await writeFile(log, "");
    await assert.rejects(
        resolveOwnedDirectory({ id: "session-alpha", locationPath: log, sessionRoot: fixture.root }),
        (error) => error instanceof DeleteFailure && error.code === "denied-path",
    );
});

test("resolveOwnedDirectory refuses a relative or missing log path", async () => {
    await assert.rejects(
        resolveOwnedDirectory({ id: "session-alpha", locationPath: "sessions/p/session-alpha/x", sessionRoot: "/tmp" }),
        (error) => error instanceof DeleteFailure && error.code === "denied-path",
    );
    await assert.rejects(
        resolveOwnedDirectory({ id: "session-alpha", locationPath: undefined, sessionRoot: "/tmp" }),
        (error) => error instanceof DeleteFailure && error.code === "denied-path",
    );
});

test("resolveOwnedDirectory tolerates an already-removed directory", async (t) => {
    const fixture = await sessionHome();
    t.after(fixture.cleanup);
    await rm(fixture.directory, { recursive: true, force: true });
    const owned = await resolveOwnedDirectory({ id: "session-alpha", locationPath: fixture.log, sessionRoot: fixture.root });
    assert.equal(owned.directory, fixture.directory);
});