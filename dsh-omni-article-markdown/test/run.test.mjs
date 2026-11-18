import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildArgs,
    errorMessage,
    extractSavedPath,
    isTokenBudget,
    progressWarnings,
    runMdcli,
    TRUNCATE_MARK,
} from "../src/run.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-mdcli.mjs", import.meta.url));

/** Run the fake binary with knobs and return its classified outcome. */
async function run(dir, { args = ["parse", "https://example.com"], env = {}, timeoutMs = 10_000, signal } = {}) {
    const previous = {};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        process.env[key] = value;
    }
    try {
        return await runMdcli({ bin: FAKE, args, cwd: dir, timeoutMs, signal });
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test("buildArgs omits --truncate unless a budget is a positive integer", () => {
    assert.deepEqual(buildArgs({ mode: "parse", target: "u" }), ["parse", "u"]);
    assert.deepEqual(buildArgs({ mode: "parse", target: "u", maxTokens: 0 }), ["parse", "u"]);
    assert.deepEqual(buildArgs({ mode: "parse", target: "u", maxTokens: "300" }), ["parse", "u"]);
    assert.deepEqual(buildArgs({ mode: "parse", target: "u", maxTokens: 300 }), ["parse", "u", "--truncate", "300"]);
    assert.deepEqual(buildArgs({ mode: "parse", target: "u", maxTokens: 800 }), ["parse", "u", "--truncate", "800"]);
});

test("buildArgs maps save, SSL, raw_html and prettify", () => {
    assert.deepEqual(buildArgs({ mode: "parse", target: "u", save: "/out", noVerifySsl: true }), [
        "parse",
        "u",
        "--save",
        "/out",
        "--no-verify-ssl",
    ]);
    assert.deepEqual(buildArgs({ mode: "read", target: "u", prettify: true, maxTokens: 300, save: "/out" }), [
        "read",
        "u",
        "--prettify",
    ]);
});

test("isTokenBudget rejects zero, floats, and non-numbers", () => {
    assert.equal(isTokenBudget(1), true);
    assert.equal(isTokenBudget(0), false);
    assert.equal(isTokenBudget(1.5), false);
    assert.equal(isTokenBudget("300"), false);
    assert.equal(isTokenBudget(undefined), false);
});

test("extractSavedPath reads the last mdcli save line", () => {
    assert.equal(extractSavedPath(["Rendering", "Article saved to: /tmp/a.md"]), "/tmp/a.md");
    assert.equal(extractSavedPath(["Article saved to: /tmp/a.md", "Article saved to: /tmp/b.md"]), "/tmp/b.md");
    assert.equal(extractSavedPath(["nothing here"]), null);
});

test("progressWarnings keeps only trailing progress lines", () => {
    assert.deepEqual(progressWarnings(["noise 1", "noise 2", "noise 3", "Article saved to: /x", "Error: nope"]), [
        "noise 1",
        "noise 2",
        "noise 3",
    ]);
    assert.deepEqual(progressWarnings([], 3), []);
});

test("errorMessage prefers the last Error: line", () => {
    assert.equal(
        errorMessage("Traceback\nValueError\nError: Failed to extract article content.\n", 1),
        "Failed to extract article content.",
    );
    assert.equal(errorMessage("", 3), "mdcli exited with code 3 and no error message");
});

test("runMdcli returns Markdown and detects the truncate marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const plain = await run(dir);
    assert.equal(plain.kind, "ok");
    assert.match(plain.stdout, /^# Title/u);
    assert.equal(plain.truncated, false);

    const truncated = await run(dir, { args: ["parse", "https://example.com", "--truncate", "300"] });
    assert.equal(truncated.kind, "ok");
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.stdout.trimEnd().endsWith(TRUNCATE_MARK));
});

test("runMdcli reports the saved path from stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const result = await run(dir, {
        args: ["parse", "https://example.com", "--save", dir],
        env: { FAKE_MDCLI_MODE: "save" },
    });
    assert.equal(result.kind, "ok");
    assert.equal(result.stdout, "");
    assert.equal(result.savedPath, `${dir}/article-file.md`);
});

test("runMdcli classifies a failure with its exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const result = await run(dir, { env: { FAKE_MDCLI_MODE: "error" } });
    assert.equal(result.kind, "error");
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, "Failed to extract article content.");
});

test("runMdcli survives an empty successful run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const result = await run(dir, { env: { FAKE_MDCLI_MODE: "empty" } });
    assert.equal(result.kind, "ok");
    assert.equal(result.stdout, "");
});

test("runMdcli times out and kills the child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const started = Date.now();
    const result = await run(dir, { env: { FAKE_MDCLI_SLEEP_MS: "5000" }, timeoutMs: 150 });
    assert.equal(result.kind, "timeout");
    assert.ok(Date.now() - started < 4000, "should not wait for the child to finish");
});

test("runMdcli reports an abort as aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const controller = new AbortController();
    const pending = run(dir, { env: { FAKE_MDCLI_SLEEP_MS: "5000" }, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.kind, "aborted");
});

test("runMdcli fails cleanly when the binary does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-run-"));
    const result = await runMdcli({ bin: join(dir, "missing-mdcli"), args: ["parse", "u"], cwd: dir, timeoutMs: 1000 });
    assert.equal(result.kind, "error");
    assert.match(result.message, /ENOENT|no such file/u);
});
