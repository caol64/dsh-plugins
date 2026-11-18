import assert from "node:assert/strict";
import { test } from "node:test";

const {
    bodySnippet,
    BUSINESS_CODES,
    failureFromError,
    failureFromResponse,
    failureText,
    kindForStatus,
    redact,
    shouldRetry,
} = await import("../src/errors.mjs");

const SECRET = "zhihu-secret-value-1234";

test("HTTP statuses map to failure kinds", () => {
    assert.equal(kindForStatus(401), "auth");
    assert.equal(kindForStatus(403), "auth");
    assert.equal(kindForStatus(404), "not_found");
    assert.equal(kindForStatus(429), "quota");
    assert.equal(kindForStatus(500), "upstream");
    assert.equal(kindForStatus(503), "upstream");
    assert.equal(kindForStatus(400), "argument");
});

test("every documented business code has a kind", () => {
    assert.deepEqual(Object.keys(BUSINESS_CODES).map(Number).sort((a, b) => a - b), [
        10001, 20001, 30001, 30002, 30003, 40004, 40005, 40006, 50002, 90001,
    ]);
});

test("only transient kinds are retryable", () => {
    assert.equal(shouldRetry({ kind: "timeout" }), true);
    assert.equal(shouldRetry({ kind: "network" }), true);
    assert.equal(shouldRetry({ kind: "upstream" }), true);
    for (const kind of ["auth", "quota", "risk", "argument", "not_found", "aborted", "unconfigured"]) {
        assert.equal(shouldRetry({ kind }), false, kind);
    }
});

test("a business code outranks the HTTP status", () => {
    const failure = failureFromResponse({ status: 200, code: 20001, message: "invalid token" });
    assert.equal(failure.kind, "auth");
    assert.equal(failure.retryable, false);
    assert.match(failure.text, /Access Secret 无效/u);

    const risky = failureFromResponse({ status: 200, code: 30003 });
    assert.equal(risky.kind, "risk");
    assert.match(risky.text, /风控/u);
    assert.equal(risky.retryable, false);

    const quota = failureFromResponse({ status: 429 });
    assert.equal(quota.kind, "quota");
    assert.match(quota.text, /不要立即重复调用/u);
    assert.equal(quota.retryable, false);
});

test("messages are actionable and never contain the secret", () => {
    const failure = failureFromResponse(
        { status: 401, message: `bad key ${SECRET}` },
        { secrets: [SECRET] },
    );
    assert.equal(failure.text.includes(SECRET), false);
    assert.match(failure.text, /\*\*\*/u);
    const snippet = bodySnippet(`<html> deny ${SECRET} </html>`, [SECRET]);
    assert.equal(snippet.includes(SECRET), false);
    assert.equal(redact(`a${SECRET}b`, [SECRET]), "a***b");
});

test("the unconfigured message names the settings page and the environment variable", () => {
    const text = failureText("unconfigured", { ref: "ZHIHU_TEAM_SECRET" });
    assert.match(text, /设置 → 知乎全网搜索/u);
    assert.match(text, /ZHIHU_TEAM_SECRET/u);
    assert.match(text, /developer\.zhihu\.com/u);
});

test("caller cancellation is not reported as an upstream failure", () => {
    const controller = new AbortController();
    controller.abort();
    const failure = failureFromError(Object.assign(new Error("aborted"), { name: "AbortError" }), {
        timeout: false,
        callerSignal: controller.signal,
    });
    assert.equal(failure.kind, "aborted");
    assert.equal(failure.retryable, false);
});

test("our own timeout and transport errors are retryable", () => {
    const timeout = failureFromError(Object.assign(new Error("timeout"), { name: "TimeoutError" }), {
        timeout: true,
        timeoutMs: 30_000,
    });
    assert.equal(timeout.kind, "timeout");
    assert.equal(timeout.retryable, true);
    assert.match(timeout.text, /30000ms/u);

    const network = failureFromError(new TypeError("fetch failed"), { timeout: false, baseURL: "https://x.test" });
    assert.equal(network.kind, "network");
    assert.equal(network.retryable, true);
    assert.match(network.text, /https:\/\/x\.test/u);
});