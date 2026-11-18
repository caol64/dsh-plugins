import assert from "node:assert/strict";
import { test } from "node:test";

const { buildHeaders, SearchFailure, searchGlobal } = await import("../src/search.mjs");
const { ArgumentError } = await import("../src/endpoint.mjs");

const SECRET = "zhihu-secret-value-1234";
const BASE = "https://developer.zhihu.com";

/**
 * A recording fetch stand-in. Each queued step either resolves a response-like
 * object or throws; the last step repeats when the queue runs dry.
 * @param {Array<{ status?: number, body?: string, throws?: Error }>} steps - queued outcomes.
 */
function fakeFetch(steps) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers, signal: init.signal, method: init.method });
        const step = steps[Math.min(calls.length - 1, steps.length - 1)];
        if (step.throws) throw step.throws;
        return {
            ok: step.status >= 200 && step.status < 300,
            status: step.status ?? 200,
            text: async () => step.body ?? "{}",
        };
    };
    fn.calls = calls;
    return fn;
}

const okBody = JSON.stringify({
    Code: 0,
    Message: "success",
    Data: { Items: [{ Title: "标题", Url: "https://example.com/a", Excerpt: "摘要" }] },
});

/**
 * Run the pipeline with fixed dependencies.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {{ steps?: any[], secret?: string | null, signal?: AbortSignal }} [options] - overrides.
 */
function run(args, options = {}) {
    const fetchImpl = fakeFetch(options.steps ?? [{ status: 200, body: okBody }]);
    const call = searchGlobal(args, {
        config: { baseURL: BASE, timeoutMs: 1_000 },
        ref: "ZHIHU_ACCESS_SECRET",
        resolveSecret: async () =>
            options.secret === null ? undefined : { value: options.secret ?? SECRET, source: "credentials" },
        signal: options.signal,
        fetchImpl,
        maxChars: 12_000,
        now: () => 1_778_494_631_000,
    });
    return { call, fetchImpl };
}

test("buildHeaders sends the bearer token and a second-level timestamp", () => {
    assert.deepEqual(buildHeaders(SECRET, 1_778_494_631_987), {
        Authorization: `Bearer ${SECRET}`,
        "X-Request-Timestamp": "1778494631",
        Accept: "application/json",
    });
});

test("an unconfigured secret never reaches the network", async () => {
    const { call, fetchImpl } = run({ query: "知乎" }, { secret: null });
    await assert.rejects(call, (error) => {
        assert.ok(error instanceof SearchFailure);
        assert.match(error.message, /尚未配置知乎 Access Secret/u);
        return true;
    });
    assert.equal(fetchImpl.calls.length, 0);
});

test("a blank query is an argument error raised before the secret resolves", async () => {
    let resolved = false;
    const fetchImpl = fakeFetch([{ status: 200, body: okBody }]);
    const call = searchGlobal(
        { query: "   " },
        {
            config: { baseURL: BASE, timeoutMs: 1_000 },
            resolveSecret: async () => {
                resolved = true;
                return { value: SECRET };
            },
            fetchImpl,
            maxChars: 12_000,
        },
    );
    await assert.rejects(call, ArgumentError);
    assert.equal(resolved, false);
    assert.equal(fetchImpl.calls.length, 0);
});

test("a successful call returns the projected items and one request", async () => {
    const { call, fetchImpl } = run({ query: "知乎", count: 5 });
    const output = await call;
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(output.query, "知乎");
    assert.equal(output.count, 5);
    assert.equal(output.items.length, 1);
    assert.equal(output.items[0].title, "标题");
    assert.equal(output.truncated, false);
    assert.deepEqual(output.warnings, []);
    // The secret rides only the Authorization header of the upstream request.
    assert.equal(fetchImpl.calls[0].headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(JSON.stringify(output).includes(SECRET), false);
});

test("a transient 5xx is retried once and then succeeds", async () => {
    const { call, fetchImpl } = run(
        { query: "知乎" },
        { steps: [{ status: 503, body: "{}" }, { status: 200, body: okBody }] },
    );
    const output = await call;
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(output.warnings.join(" "), /已自动重试一次并成功/u);
});

test("a persistent 5xx stops after two attempts", async () => {
    const { call, fetchImpl } = run({ query: "知乎" }, { steps: [{ status: 500, body: "{}" }] });
    await assert.rejects(call, (error) => {
        assert.ok(error instanceof SearchFailure);
        assert.equal(error.kind, "upstream");
        assert.match(error.message, /暂时不可用/u);
        return true;
    });
    assert.equal(fetchImpl.calls.length, 2);
});

test("quota, auth and risk failures are never retried", async () => {
    for (const [status, body, pattern] of [
        [200, JSON.stringify({ Code: 30001, Message: "quota", Data: null }), /额度不足或被限频/u],
        [401, "{}", /鉴权失败/u],
        [200, JSON.stringify({ Code: 30003, Message: "risk", Data: null }), /风控/u],
        [400, JSON.stringify({ Code: 10001, Message: "bad filter", Data: null }), /拒绝了请求参数/u],
    ]) {
        const { call, fetchImpl } = run({ query: "知乎" }, { steps: [{ status, body }] });
        await assert.rejects(call, (error) => {
            assert.ok(error instanceof SearchFailure, String(error));
            assert.match(error.message, pattern);
            return true;
        });
        assert.equal(fetchImpl.calls.length, 1, `status ${status}`);
    }
});

test("a non-JSON success body is classified as an upstream failure with a redacted snippet", async () => {
    const body = `<html>${SECRET}</html>`;
    const { call } = run({ query: "知乎" }, { steps: [{ status: 200, body }] });
    await assert.rejects(call, (error) => {
        assert.equal(error.kind, "upstream");
        assert.equal(error.message.includes(SECRET), false);
        assert.match(error.message, /响应片段/u);
        return true;
    });
});

test("a transport error is retried once", async () => {
    const failure = Object.assign(new TypeError("fetch failed"), {});
    const { call, fetchImpl } = run({ query: "知乎" }, { steps: [{ throws: failure }] });
    await assert.rejects(call, /无法连接知乎开放平台/u);
    assert.equal(fetchImpl.calls.length, 2);
});

test("a timeout is retried once and reported as such", async () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const { call, fetchImpl } = run({ query: "知乎" }, { steps: [{ throws: timeout }] });
    await assert.rejects(call, /超时/u);
    assert.equal(fetchImpl.calls.length, 2);
});

test("caller cancellation surfaces as an AbortError, not as an upstream failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const { call, fetchImpl } = run({ query: "知乎" }, { steps: [{ throws: abort }], signal: controller.signal });
    await assert.rejects(call, (error) => {
        assert.equal(error.name, "AbortError");
        return true;
    });
    assert.equal(fetchImpl.calls.length, 1);
});

test("an unrecognized Data shape keeps the raw payload and explains itself", async () => {
    const body = JSON.stringify({ Code: 0, Data: { Opaque: "x" } });
    const { call } = run({ query: "知乎" }, { steps: [{ status: 200, body }] });
    const output = await call;
    assert.deepEqual(output.items[0], { raw: { Opaque: "x" } });
    assert.match(output.warnings.join(" "), /原始 Data/u);
});

test("the text budget is reported through truncated", async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
        Title: `第 ${index} 条`,
        Excerpt: "摘要 ".repeat(60),
    }));
    const body = JSON.stringify({ Code: 0, Data: { Items: items } });
    const fetchImpl = fakeFetch([{ status: 200, body }]);
    const output = await searchGlobal(
        { query: "知乎", count: 6 },
        {
            config: { baseURL: BASE, timeoutMs: 1_000 },
            resolveSecret: async () => ({ value: SECRET }),
            fetchImpl,
            maxChars: 400,
        },
    );
    assert.equal(output.items.length, 6);
    assert.equal(output.truncated, true);
});