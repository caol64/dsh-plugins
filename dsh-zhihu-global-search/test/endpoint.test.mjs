import assert from "node:assert/strict";
import { test } from "node:test";

const { buildUrl, clampCount, COUNT_MAX, normalizeBaseURL, normalizeRequest, SEARCH_PATH } = await import(
    "../src/endpoint.mjs"
);

test("normalizeRequest trims the query and defaults count / search_db", () => {
    const request = normalizeRequest({ query: "  知乎 搜索  " });
    assert.deepEqual(request, { query: "知乎 搜索", count: 10, filter: "", searchDb: "all", warnings: [] });
});

test("normalizeRequest rejects a blank query with actionable text", () => {
    for (const query of [undefined, "", "   ", 42, null]) {
        assert.throws(() => normalizeRequest({ query }), /query 必须是非空字符串/u);
    }
});

test("normalizeRequest clamps count and explains the clamp", () => {
    assert.equal(normalizeRequest({ query: "a", count: 0 }).count, 1);
    assert.equal(normalizeRequest({ query: "a", count: 99 }).count, COUNT_MAX);
    assert.equal(normalizeRequest({ query: "a", count: 7 }).count, 7);

    const clamped = normalizeRequest({ query: "a", count: 50 });
    assert.equal(clamped.count, COUNT_MAX);
    assert.equal(clamped.warnings.length, 1);
    assert.match(clamped.warnings[0], /count 已从 50 钳制为 20/u);

    // An exact in-range integer produces no warning.
    assert.deepEqual(normalizeRequest({ query: "a", count: 7 }).warnings, []);
});

test("clampCount handles non-integers and junk", () => {
    assert.equal(clampCount(5.9), 5);
    assert.equal(clampCount(-3), 1);
    assert.equal(clampCount("8"), 8);
    assert.equal(clampCount("nope"), 10);
    assert.equal(clampCount(undefined), 10);
});

test("normalizeRequest validates search_db strictly", () => {
    assert.equal(normalizeRequest({ query: "a", search_db: "realtime" }).searchDb, "realtime");
    assert.equal(normalizeRequest({ query: "a", search_db: " STATIC " }).searchDb, "static");
    assert.throws(() => normalizeRequest({ query: "a", search_db: "archive" }), /search_db 只接受 all \/ realtime \/ static/u);
});

test("normalizeRequest passes the filter through and drops an empty one", () => {
    assert.equal(normalizeRequest({ query: "a", filter: ' host=="x.com" ' }).filter, 'host=="x.com"');
    assert.equal(normalizeRequest({ query: "a", filter: "   " }).filter, "");
    assert.equal(normalizeRequest({ query: "a", filter: 12 }).filter, "");
});

test("buildUrl uses the documented wire names and omits an empty filter", () => {
    const url = buildUrl("https://developer.zhihu.com", normalizeRequest({ query: "知乎", count: 3 }));
    assert.equal(url.pathname, SEARCH_PATH);
    assert.equal(url.searchParams.get("Query"), "知乎");
    assert.equal(url.searchParams.get("Count"), "3");
    assert.equal(url.searchParams.get("SearchDB"), "all");
    assert.equal(url.searchParams.has("Filter"), false);

    const filtered = buildUrl(
        "https://gw.example.com/base/",
        normalizeRequest({ query: "a", filter: 'host=="x.com"', search_db: "realtime" }),
    );
    assert.equal(filtered.pathname, `/base${SEARCH_PATH}`);
    assert.equal(filtered.searchParams.get("Filter"), 'host=="x.com"');
    assert.equal(filtered.searchParams.get("SearchDB"), "realtime");
});

test("normalizeBaseURL validates the protocol and keeps a base path", () => {
    assert.equal(normalizeBaseURL("https://developer.zhihu.com/"), "https://developer.zhihu.com");
    assert.equal(normalizeBaseURL("http://127.0.0.1:8080/gw/"), "http://127.0.0.1:8080/gw");
    assert.throws(() => normalizeBaseURL("ftp://x"), /只支持 http\/https/u);
    assert.throws(() => normalizeBaseURL("not a url"), /不是合法 URL/u);
});