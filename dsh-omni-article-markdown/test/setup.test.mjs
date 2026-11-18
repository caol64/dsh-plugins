import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInstallCache, installMdcli, pythonFor, tail } from "../src/setup.mjs";

/**
 * Put fake executables on PATH for the duration of one test.
 * @param {Record<string, string>} scripts - file name -> shell body.
 * @param {() => Promise<void>} body - test body.
 */
async function withPath(scripts, body) {
    const dir = await mkdtemp(join(tmpdir(), "omni-setup-"));
    for (const [file, contents] of Object.entries(scripts)) {
        await writeFile(join(dir, file), contents, { mode: 0o755 });
        await chmod(join(dir, file), 0o755);
    }
    const previous = process.env.PATH;
    process.env.PATH = `${dir}`;
    try {
        await body();
    } finally {
        process.env.PATH = previous;
    }
}

test("installMdcli falls back from a failing pipx to a working uv", async () => {
    await withPath(
        {
            pipx: '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.7.1; exit 0; }\necho "pipx: no space left" >&2\nexit 1\n',
            uv: '#!/bin/sh\n[ "$1" = "--version" ] && { echo "uv 0.5.0"; exit 0; }\necho "installed omni-article-markdown"\n',
        },
        async () => {
            const outcome = await installMdcli({
                timeoutMs: 20_000,
                probe: async () => ({
                    installed: true,
                    bin: "mdcli",
                    version: "0.2.4",
                    versionParts: [0, 2, 4],
                    error: null,
                }),
            });
            assert.equal(outcome.ok, true);
            assert.equal(outcome.strategy, "uv");
            assert.ok(outcome.log.some((line) => line.includes("pipx") && line.includes("失败")));
        },
    );
});

test("installMdcli reports every strategy when none succeeds", async () => {
    await withPath(
        {
            pipx: '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.7.1; exit 0; }\necho "pipx boom" >&2\nexit 1\n',
            uv: '#!/bin/sh\n[ "$1" = "--version" ] && { echo "uv 0.5.0"; exit 0; }\necho "uv boom" >&2\nexit 1\n',
            python3:
                '#!/bin/sh\n[ "$1" = "--version" ] && { echo "Python 3.14.0"; exit 0; }\necho "pip boom" >&2\nexit 1\n',
        },
        async () => {
            const outcome = await installMdcli({ timeoutMs: 20_000, probe: async () => ({ installed: false }) });
            assert.equal(outcome.ok, false);
            assert.ok(outcome.log.some((line) => /pipx boom/u.test(line)));
            assert.ok(outcome.log.some((line) => /uv boom/u.test(line)));
            assert.ok(outcome.log.some((line) => /pip boom/u.test(line)));
        },
    );
});

test("installMdcli fails when a strategy installs nothing runnable", async () => {
    await withPath(
        {
            pipx: '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.7.1; exit 0; }\necho "installed"\n',
        },
        async () => {
            const outcome = await installMdcli({ timeoutMs: 20_000, probe: async () => ({ installed: false }) });
            assert.equal(outcome.ok, false);
            assert.ok(outcome.log.some((line) => line.includes("command")));
        },
    );
});

test("pythonFor reads the mdcli shebang", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-setup-"));
    const bin = join(dir, "mdcli");
    await writeFile(bin, "#!/opt/venv/bin/python\nprint(1)\n", { mode: 0o755 });
    assert.equal(await pythonFor(bin), "/opt/venv/bin/python");
    assert.equal(await pythonFor("mdcli"), null);
    assert.equal(await pythonFor(join(dir, "missing")), null);
});

test("tail keeps the last informative lines", () => {
    assert.equal(tail("a\nb\n\nc\nd\ne", 3), "c | d | e");
    assert.equal(tail(""), "");
});

test("createInstallCache serializes concurrent installs and caches success", async () => {
    let runs = 0;
    const cache = createInstallCache(async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, strategy: "uv", log: [] };
    });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(a, b);
    assert.equal(runs, 1);
    await cache.get();
    assert.equal(runs, 1);
});
