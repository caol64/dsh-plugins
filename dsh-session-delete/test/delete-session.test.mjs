import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DeleteFailure } from "../src/errors.mjs";
import { deleteSession, deleteSessionChecked, optional } from "../src/delete-session.mjs";

const ID = "session-alpha";
const OTHER = "session-beta";

/**
 * The statuses Cordis refuses to serve from a context that did not inject them.
 * Reading one through `ctx.<name>` must throw, exactly as the real proxy does —
 * a fixture that just returns undefined would let a missing-inject bug pass.
 */
const ABSENT = new Set(["nope"]);

/**
 * Build a fake host context.
 *
 * `ctx.<service>` throws for a service listed in {@link ABSENT} (mimicking
 * "cannot get property without inject"), returns the supplied fake otherwise,
 * and `ctx.get/emit/effect` are recorded so assertions can read what happened.
 * @param {Record<string, unknown>} services - fake services by name.
 * @param {{ absent?: string[] }} [options] - services whose access must throw.
 * @returns {{ ctx: object, emitted: Array<[string, ...unknown[]]>, warned: string[] }} the fake and its log.
 */
function fakeContext(services, options = {}) {
    const absent = new Set([...ABSENT, ...(options.absent ?? [])]);
    const emitted = [];
    const warned = [];
    const target = {
        emit: (name, ...args) => {
            emitted.push([name, ...args]);
        },
        effect: (fn) => (typeof fn === "function" ? fn() : undefined),
        get: (name) => (absent.has(name) ? undefined : services[name]),
        logger: {
            info: () => {},
            warn: (message, ...args) => warned.push(String(message).replace(/%s/g, () => String(args.shift()))),
        },
    };
    const ctx = new Proxy(target, {
        get(object, key) {
            if (typeof key !== "string" || key in object) return Reflect.get(object, key);
            if (absent.has(key)) throw new Error(`cannot get property "${key}" without inject`);
            return services[key];
        },
        has: (object, key) => (typeof key === "string" && key in object) || !absent.has(String(key)),
    });
    return { ctx, emitted, warned };
}

/**
 * Create a harness home holding one stored session and its projection cache.
 * @param {{ id?: string }} [options] - the session id to lay out.
 * @returns {Promise<{ home: string, root: string, dir: string, log: string, cache: string, cleanup: () => Promise<void> }>} the fixture.
 */
async function fixture({ id = ID } = {}) {
    const home = await mkdtemp(path.join(tmpdir(), "dsh-session-delete-"));
    const root = path.join(home, "sessions");
    const dir = path.join(root, "--tmp-project--", id);
    const log = path.join(dir, "session.v4.jsonl.zstd");
    const cacheDir = path.join(home, "storages", "session_projcache", "sessions");
    const cache = path.join(cacheDir, `${id}.json`);
    await mkdir(dir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(log, "log");
    await writeFile(path.join(dir, "session.lock"), "");
    await writeFile(cache, "{}");
    await writeFile(path.join(cacheDir, `${OTHER}.json`), "{}");
    return { home, root, dir, log, cache, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/**
 * Assemble the fake services one run needs.
 * @param {Awaited<ReturnType<typeof fixture>>} home - the fixture paths.
 * @param {Record<string, unknown>} [overrides] - services to replace or add.
 * @returns {{ services: Record<string, unknown>, calls: Record<string, unknown[]> }} services and their call log.
 */
function services(home, overrides = {}) {
    const calls = { cancel: [], detach: [], removedFromCache: [], unarchive: [], unpin: [] };
    const base = {
        sessionPersistence: {
            stat: async (id) => (id === ID ? { header: { id }, location: { kind: "jsonl", path: home.log } } : undefined),
        },
        sessions: { get: () => undefined },
        agents: { get: () => undefined },
        sessionController: { cancel: (request) => calls.cancel.push(request) },
        workspaceRegistry: {
            list: () => [
                { id: "ws-1", sessionIds: [ID], detachSession: async (sessionId) => calls.detach.push(["ws-1", sessionId]) },
                { id: "ws-2", sessionIds: [], detachSession: async (sessionId) => calls.detach.push(["ws-2", sessionId]) },
            ],
            unarchiveSession: async (id) => calls.unarchive.push(id),
            unpinSession: async (id) => calls.unpin.push(id),
        },
        storageDomain: {
            get: (name) =>
                name === "session_projcache"
                    ? {
                          table: (table) =>
                              table === "sessions"
                                  ? {
                                        delete: async (id) => {
                                            calls.removedFromCache.push(id);
                                            return true;
                                        },
                                    }
                                  : undefined,
                      }
                    : undefined,
        },
        ...overrides,
    };
    return { services: base, calls };
}

/** The runtime config a run receives. */
function config(home, overrides = {}) {
    return { home: home.home, stopTimeoutMs: 200, allowDeleteRunning: true, deleteProjectionCache: true, ...overrides };
}

test("a full deletion removes the log directory, the cache record, and the accounting", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc, calls } = services(home);
    const { ctx, emitted } = fakeContext(svc);

    const result = await deleteSession(ctx, { sessionId: ID }, config(home));

    assert.equal(result.sessionId, ID);
    assert.equal(result.stopped, false);
    assert.deepEqual(result.removed.length, 1);
    await assert.rejects(access(home.dir), { code: "ENOENT" });
    await assert.rejects(access(home.cache), { code: "ENOENT" });
    assert.equal((await readdir(path.dirname(home.cache))).includes(`${OTHER}.json`), true, "another session's cache survives");
    assert.deepEqual(calls.removedFromCache, [ID]);
    assert.deepEqual(calls.unarchive, [ID]);
    assert.deepEqual(calls.unpin, [ID]);
    assert.deepEqual(calls.detach, [
        ["ws-1", ID],
        ["ws-2", ID],
    ]);
    assert.deepEqual(emitted, [["api-session/removed", ID]]);
    assert.deepEqual(result.warnings, []);
});

test("an unknown session is refused before anything is touched", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, { sessionPersistence: { stat: async () => undefined } });
    const { ctx, emitted } = fakeContext(svc);

    await assert.rejects(deleteSession(ctx, { sessionId: ID }, config(home)), (error) => error instanceof DeleteFailure && error.code === "session-not-found");
    await access(home.log);
    assert.deepEqual(emitted, []);
});

test("an invalid id is refused before any filesystem or service access", async () => {
    let touched = false;
    const { ctx } = fakeContext(
        {
            get sessionPersistence() {
                touched = true;
                return undefined;
            },
        },
        { absent: ["sessionPersistence"] },
    );
    await assert.rejects(deleteSession(ctx, { sessionId: "../escape" }, { home: undefined, stopTimeoutMs: 10, allowDeleteRunning: true, deleteProjectionCache: true }), (error) => error instanceof DeleteFailure && error.code === "invalid-id");
    assert.equal(touched, false);
});

test("a running session is cancelled and settled before deletion", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    let status = "running";
    let cancelCalled = 0;
    const { services: svc, calls } = services(home, {
        agents: {
            get: (id) => (id === ID ? { status } : undefined),
        },
        sessionController: {
            cancel: (request) => {
                calls.cancel.push(request);
                cancelCalled += 1;
                status = "idle";
            },
        },
    });
    const { ctx } = fakeContext(svc);

    const result = await deleteSession(ctx, { sessionId: ID }, config(home));

    assert.equal(cancelCalled, 1);
    assert.equal(result.stopped, true);
    assert.deepEqual(calls.cancel, [{ sessionId: ID }]);
    await assert.rejects(access(home.dir), { code: "ENOENT" });
});

test("a running session is refused when the profile forbids deleting it", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc, calls } = services(home, { agents: { get: () => ({ status: "running" }) } });
    const { ctx, emitted } = fakeContext(svc);

    await assert.rejects(deleteSession(ctx, { sessionId: ID }, config(home, { allowDeleteRunning: false })), (error) => error instanceof DeleteFailure && error.code === "agent-busy");
    assert.deepEqual(calls.cancel, []);
    await access(home.log);
    assert.deepEqual(emitted, []);
});

test("a turn that will not stop leaves every file in place", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, { agents: { get: () => ({ status: "running" }) } });
    const { ctx, emitted } = fakeContext(svc);

    await assert.rejects(deleteSession(ctx, { sessionId: ID }, config(home, { stopTimeoutMs: 60 })), (error) => error instanceof DeleteFailure && error.code === "agent-stuck");
    await access(home.log);
    await access(home.cache);
    assert.deepEqual(emitted, []);
});

test("a stored snapshot without a log path is refused rather than guessed at", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, { sessionPersistence: { stat: async () => ({ header: { id: ID } }) } });
    const { ctx } = fakeContext(svc);
    await assert.rejects(deleteSession(ctx, { sessionId: ID }, config(home)), (error) => error instanceof DeleteFailure && error.code === "session-not-found");
    await access(home.log);
});

test("a live session with no stored log path is refused rather than guessed at", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, {
        sessionPersistence: { stat: async () => undefined },
        sessions: { get: (id) => (id === ID ? { id } : undefined) },
    });
    const { ctx } = fakeContext(svc);
    await assert.rejects(deleteSession(ctx, { sessionId: ID }, config(home)), (error) => error instanceof DeleteFailure && error.code === "denied-path");
    await access(home.log);
});

test("a missing projection cache is not an error", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc, calls } = services(home, { storageDomain: undefined });
    const { ctx } = fakeContext(svc);
    const result = await deleteSession(ctx, { sessionId: ID }, config(home));
    assert.deepEqual(calls.removedFromCache, []);
    assert.deepEqual(result.warnings, []);
    await assert.rejects(access(home.cache), { code: "ENOENT" });
});

test("a failing cache domain becomes a warning, not a refusal", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, {
        storageDomain: {
            get: () => ({
                table: () => ({
                    delete: async () => {
                        throw new Error("storage unavailable");
                    },
                }),
            }),
        },
    });
    const { ctx, emitted } = fakeContext(svc);
    const result = await deleteSession(ctx, { sessionId: ID }, config(home));
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /storage unavailable/);
    await assert.rejects(access(home.dir), { code: "ENOENT" });
    assert.deepEqual(emitted, [["api-session/removed", ID]]);
});

test("a failing accounting step becomes a warning, not a refusal", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, {
        workspaceRegistry: {
            list: () => [{ id: "ws-1", sessionIds: [ID], detachSession: async () => { throw new Error("detach failed"); } }],
            unarchiveSession: async () => { throw new Error("unarchive failed"); },
            unpinSession: async () => {},
        },
    });
    const { ctx, emitted } = fakeContext(svc);
    const result = await deleteSession(ctx, { sessionId: ID }, config(home));
    assert.equal(result.warnings.length, 2);
    assert.deepEqual(emitted, [["api-session/removed", ID]]);
    await assert.rejects(access(home.dir), { code: "ENOENT" });
});

test("the projection cache can be kept by configuration", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc, calls } = services(home);
    const { ctx } = fakeContext(svc);
    await deleteSession(ctx, { sessionId: ID }, config(home, { deleteProjectionCache: false }));
    assert.deepEqual(calls.removedFromCache, []);
    await access(home.cache);
    await assert.rejects(access(home.dir), { code: "ENOENT" });
});

test("a second deletion reports not-found and touches nothing", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc, calls } = services(home);
    // A real persistence backend stops reporting the session once its log is
    // gone; the fake mirrors that so the second run reaches not-found.
    let stored = true;
    svc.sessionPersistence = {
        stat: async (id) => (id === ID && stored ? { header: { id }, location: { kind: "jsonl", path: home.log } } : undefined),
    };
    const { ctx, emitted } = fakeContext(svc);
    await deleteSession(ctx, { sessionId: ID }, config(home));
    stored = false;
    await assert.rejects(deleteSession(ctx, { sessionId: ID }, config(home)), (error) => error instanceof DeleteFailure && error.code === "session-not-found");
    assert.equal(calls.removedFromCache.length, 1);
    assert.equal(emitted.length, 1);
});

test("a host without a workspace registry still deletes and announces", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, { workspaceRegistry: undefined, storageDomain: undefined });
    const { ctx, emitted } = fakeContext(svc);
    const result = await deleteSession(ctx, { sessionId: ID }, config(home));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(emitted, [["api-session/removed", ID]]);
});

test("deleteSessionChecked normalizes an unexpected fault and logs the detail", async (t) => {
    const home = await fixture();
    t.after(home.cleanup);
    const { services: svc } = services(home, {
        sessionPersistence: {
            stat: async () => {
                throw new Error("disk on fire");
            },
        },
    });
    const { ctx, warned } = fakeContext(svc);
    await assert.rejects(deleteSessionChecked(ctx, { sessionId: ID }, config(home)), (error) => error instanceof DeleteFailure && error.code === "delete-failed");
    assert.equal(warned.some((line) => line.includes("disk on fire")), true);
    assert.equal(warned.some((line) => line.includes("delete-failed")), true);
});

test("optional() reads a service without tripping the inject guard", () => {
    const { ctx } = fakeContext({ sessions: { ok: true } }, { absent: ["missing"] });
    assert.deepEqual(optional(ctx, "sessions"), { ok: true });
    assert.equal(optional(ctx, "missing"), undefined);
    assert.throws(() => ctx.missing, /without inject/);
});

test("optional() prefers ctx.get, which a nested inject child needs", () => {
    // Regression: inside `ctx.inject(['connection'], child => …)` the child only
    // serves property access for its declared dependency, so `child.sessions`
    // is undefined while `child.get('sessions')` still resolves. Reading services
    // through the property form there made every delete answer session-not-found.
    const services = { sessions: { id: "live" }, sessionPersistence: { stat: async () => undefined } };
    const child = {
        get: (name) => services[name],
        // Property access deliberately yields nothing, exactly like the real child.
    };
    const parent = new Proxy(
        { get: (name) => services[name] },
        {
            get(object, key) {
                if (typeof key === "string" && key in object) return Reflect.get(object, key);
                return undefined;
            },
        },
    );
    for (const ctx of [child, parent]) {
        assert.deepEqual(optional(ctx, "sessions"), { id: "live" });
        assert.equal(typeof optional(ctx, "sessionPersistence").stat, "function");
        assert.equal(optional(ctx, "workspaceRegistry"), undefined);
    }
});