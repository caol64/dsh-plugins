import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stat } from "node:fs/promises";

import { convertArticle, projectResult, resolveSaveTarget, resolveTarget } from "../src/convert.mjs";
import { stringsFor } from "../src/tool.mjs";

const text = stringsFor("zh-CN");

/**
 * Build a runtime seam that replays scripted outcomes.
 * @param {Array<object>} script - outcomes returned by successive `run` calls.
 * @param {object} [overrides] - probe/install overrides.
 */
function fakeRuntime(script, overrides = {}) {
    const calls = { run: [], install: 0, browser: 0, deferred: [] };
    let index = 0;
    /** After a successful install the probe reports the tool; before it, `installed`. */
    let installed = overrides.installed ?? true;
    const runtime = {
        calls,
        probe: async () => ({
            installed,
            bin: "/fake/mdcli",
            version: overrides.version ?? "0.2.4",
            versionParts: (overrides.version ?? "0.2.4").split(".").map(Number),
            error: null,
        }),
        invalidateProbe: () => {},
        install: async () => {
            calls.install += 1;
            const outcome = overrides.install ?? { ok: true, log: [] };
            if (outcome.ok) installed = true;
            return outcome;
        },
        installBrowser: async () => {
            calls.browser += 1;
            return { ok: true, output: "" };
        },
        run: async (options) => {
            calls.run.push(options);
            const outcome = script[Math.min(index, script.length - 1)];
            index += 1;
            return outcome;
        },
    };
    return runtime;
}

const exec = () => ({
    signal: new AbortController().signal,
    deferContext: (message) => message,
});

const ok = (stdout, extra = {}) => ({
    kind: "ok",
    stdout,
    stderrLines: [],
    savedPath: null,
    truncated: false,
    argv: [],
    ...extra,
});
const failed = (message) => ({
    kind: "error",
    exitCode: 1,
    signal: null,
    message,
    stderr: message,
    stderrLines: [],
    argv: [],
});
const limited = (runtime, overrides = {}) => ({ timeoutMs: 1000, allowInstall: true, ...overrides });

test("resolveTarget keeps URLs and resolves relative files against the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    await writeFile(join(dir, "page.html"), "<html></html>");
    assert.equal(await resolveTarget("https://example.com/a", dir, text.targetNotFound), "https://example.com/a");
    assert.equal(await resolveTarget("page.html", dir, text.targetNotFound), join(dir, "page.html"));
});

test("resolveTarget names a foreign scheme instead of treating it as a path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    await assert.rejects(resolveTarget("ftp://example.com/a", dir, text.targetNotFound, text.badScheme), /ftp:\/\//u);
    await assert.rejects(resolveTarget("file:///etc/hosts", dir, text.targetNotFound, text.badScheme), /file:\/\//u);
});

test("resolveTarget rejects a missing local file with actionable wording", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    await assert.rejects(resolveTarget("nope.html", dir, text.targetNotFound), /nope\.html/u);
});

test("a successful conversion returns Markdown and the requested arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("# T\n\nbody\n")]);
    const value = await convertArticle(
        { url: "https://example.com", max_tokens: 400, no_verify_ssl: true },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.mode, "markdown");
    assert.equal(value.markdown, "# T\n\nbody\n");
    assert.equal(value.truncated, false);
    assert.deepEqual(runtime.calls.run[0].args, [
        "parse",
        "https://example.com",
        "--truncate",
        "400",
        "--no-verify-ssl",
    ]);
});

test("a truncated conversion is flagged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("# T\n\n…[truncated]", { truncated: true })]);
    const value = await convertArticle(
        { url: "https://example.com", max_tokens: 300 },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.truncated, true);
});

test("save mode returns the absolute path mdcli reported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("", { savedPath: "/out/Title.md" })]);
    const value = await convertArticle(
        { url: "https://example.com", save: "out" },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.mode, "saved");
    assert.equal(value.saved_path, "/out/Title.md");
    assert.equal(runtime.calls.run[0].args.at(-2), "--save");
    assert.equal(runtime.calls.run[0].args.at(-1), join(dir, "out"));
});

test("save mode explains a missing saved path instead of guessing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("", { savedPath: null })]);
    const value = await convertArticle(
        { url: "https://example.com", save: dir },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.saved_path, text.saveUnknown(dir));
});

test("raw_html uses read and warns that max_tokens is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("<html></html>")]);
    const value = await convertArticle(
        { url: "https://example.com", raw_html: true, max_tokens: 300, prettify: true },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.mode, "raw_html");
    assert.deepEqual(runtime.calls.run[0].args, ["read", "https://example.com", "--prettify"]);
    assert.ok(value.warnings.includes(text.truncateIgnored));
});

test("an extraction failure is mapped, not retried", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([failed("Failed to extract article content.")]);
    await assert.rejects(
        convertArticle(
            { url: "https://example.com" },
            { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
        ),
        /不适合作为文章提取/u,
    );
    assert.equal(runtime.calls.run.length, 1);
});

test("a timeout is retried once and then reported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const timeout = { kind: "timeout", argv: [], stderrLines: [] };
    const runtime = fakeRuntime([timeout, timeout]);
    await assert.rejects(
        convertArticle(
            { url: "https://example.com" },
            { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
        ),
        /超时/u,
    );
    assert.equal(runtime.calls.run.length, 2);
});

test("a transient failure recovers on the single retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([failed("Timeout while fetching"), ok("# ok\n")]);
    const value = await convertArticle(
        { url: "https://example.com" },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.markdown, "# ok\n");
    assert.equal(runtime.calls.run.length, 2);
});

test("a missing browser triggers one Chromium install and a retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([failed("Executable doesn't exist at chromium-1200"), ok("# fixed\n")]);
    const value = await convertArticle(
        { url: "https://example.com" },
        { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.markdown, "# fixed\n");
    assert.equal(runtime.calls.browser, 1);
    assert.ok(value.warnings.includes(text.browserFixed));
});

test("an old mdcli refuses truncation with upgrade guidance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("# never\n")], { version: "0.2.2" });
    await assert.rejects(
        convertArticle(
            { url: "https://example.com", max_tokens: 300 },
            { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
        ),
        /0\.2\.2.*--truncate/u,
    );
    assert.equal(runtime.calls.run.length, 0);
});

test("a missing mdcli is installed when allowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("# installed\n")], { installed: false, installedAfterInstall: true });
    const ctx = exec();
    const deferred = [];
    ctx.deferContext = (message) => deferred.push(message);
    const value = await convertArticle(
        { url: "https://example.com" },
        { exec: ctx, cwd: dir, runtime, limits: limited(runtime), text },
    );
    assert.equal(value.markdown, "# installed\n");
    assert.equal(runtime.calls.install, 1);
    assert.equal(deferred.length, 1);
});

test("a missing mdcli is refused when installation is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("# never\n")], { installed: false });
    await assert.rejects(
        convertArticle(
            { url: "https://example.com" },
            { exec: exec(), cwd: dir, runtime, limits: limited(runtime, { allowInstall: false }), text },
        ),
        /pipx install/u,
    );
    assert.equal(runtime.calls.install, 0);
});

test("a failed auto-install surfaces the strategy log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([ok("# never\n")], {
        installed: false,
        install: { ok: false, log: ["pipx: boom", "uv: boom"] },
    });
    await assert.rejects(
        convertArticle(
            { url: "https://example.com" },
            { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
        ),
        /pipx: boom \| uv: boom/u,
    );
});

test("an aborted run surfaces as AbortError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const runtime = fakeRuntime([{ kind: "aborted", argv: [], stderrLines: [] }]);
    await assert.rejects(
        convertArticle(
            { url: "https://example.com" },
            { exec: exec(), cwd: dir, runtime, limits: limited(runtime), text },
        ),
        { name: "AbortError" },
    );
});

test("projectResult rejects an empty successful body", () => {
    assert.throws(
        () => projectResult(ok("  \n"), { mode: "parse" }, [], text),
        new RegExp(text.emptyOutput.slice(0, 8), "u"),
    );
});
test("resolveSaveTarget creates a missing directory so mdcli treats it as one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const target = await resolveSaveTarget("notes/articles", dir);
    assert.equal(target, join(dir, "notes/articles"));
    assert.equal((await stat(target)).isDirectory(), true);
});

test("resolveSaveTarget keeps a file target and creates only its parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const target = await resolveSaveTarget("out/post.md", dir);
    assert.equal(target, join(dir, "out/post.md"));
    assert.equal((await stat(join(dir, "out"))).isDirectory(), true);
    await assert.rejects(stat(target));
});

test("resolveSaveTarget reports an unusable destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    await writeFile(join(dir, "blocker"), "x");
    await assert.rejects(resolveSaveTarget("blocker/inside", dir), /cannot create save destination/u);
});
