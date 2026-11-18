import assert from "node:assert/strict";
import { test } from "node:test";

const { decodeResponse, extraFields, locateItems, pagination, projectItem, toIsoTime } = await import(
    "../src/respond.mjs"
);

const item = {
    Title: "如何理解 RAVE 文化",
    Url: "https://www.zhihu.com/question/1",
    Excerpt: "电子音乐现场的文化解读",
    Author: "某人",
    PublishTime: 1_778_494_631,
    VoteCount: 128,
};

test("decodeResponse reads Code / Message / Data of the documented envelope", () => {
    const decoded = decodeResponse({
        status: 200,
        text: JSON.stringify({ Code: 0, Message: "success", Data: { Items: [item], HasMore: true } }),
    });
    assert.equal(decoded.json, true);
    assert.equal(decoded.code, 0);
    assert.equal(decoded.message, "success");
    assert.equal(decoded.items.length, 1);
    assert.equal(decoded.has_more, true);
});

test("decodeResponse tolerates lower-case envelopes and a numeric Code given as text", () => {
    const decoded = decodeResponse({
        status: 200,
        text: JSON.stringify({ code: "0", message: "ok", data: { items: [item] } }),
    });
    assert.equal(decoded.code, 0);
    assert.equal(decoded.items.length, 1);
});

test("decodeResponse reports a non-JSON body without throwing", () => {
    const decoded = decodeResponse({ status: 502, text: "<html>bad gateway</html>" });
    assert.equal(decoded.json, false);
    assert.deepEqual(decoded.items, []);
    assert.equal(decoded.body, "<html>bad gateway</html>");
});

test("decodeResponse keeps a bare array response", () => {
    const decoded = decodeResponse({ status: 200, text: JSON.stringify([item, item]) });
    assert.equal(decoded.items.length, 2);
});

test("locateItems walks every documented container and otherwise gives up cleanly", () => {
    for (const key of ["Items", "items", "List", "list", "Results", "results", "Data", "data"]) {
        assert.deepEqual(locateItems({ Data: { [key]: [1] } }, { [key]: [1] }), [1], key);
    }
    assert.equal(locateItems({ Data: { Unknown: 1 } }, { Unknown: 1 }), undefined);
    assert.equal(locateItems(undefined, undefined), undefined);
});

test("projectItem maps the candidate key names of each field", () => {
    const projected = projectItem(item, 0);
    assert.equal(projected.title, "如何理解 RAVE 文化");
    assert.equal(projected.url, "https://www.zhihu.com/question/1");
    assert.equal(projected.snippet, "电子音乐现场的文化解读");
    assert.equal(projected.author, "某人");
    assert.equal(projected.published_at, "2026-05-11T10:17:11.000Z");
    assert.deepEqual(projected.raw, item);

    const snake = projectItem({ question_title: "Q", source_url: "https://x", content: "C", user_name: "U" }, 1);
    assert.equal(snake.title, "Q");
    assert.equal(snake.url, "https://x");
    assert.equal(snake.snippet, "C");
    assert.equal(snake.author, "U");
});

test("projectItem never invents values and keeps unknown shapes in raw", () => {
    // No title key exists, so none is projected; the renderer adds a positional
    // label instead of the projection inventing one.
    assert.deepEqual(projectItem({ Weird: "value" }, 2), { raw: { Weird: "value" } });
    // A non-object item cannot be projected at all, so it keeps a positional
    // label for the renderer.
    assert.deepEqual(projectItem("plain string", 0), { title: "结果 1", raw: "plain string" });
});

test("toIsoTime converts epoch seconds and milliseconds but leaves other text alone", () => {
    assert.equal(toIsoTime("1778494631"), "2026-05-11T10:17:11.000Z");
    assert.equal(toIsoTime("1778494631000"), "2026-05-11T10:17:11.000Z");
    assert.equal(toIsoTime("2026-05-06"), "2026-05-06");
    assert.equal(toIsoTime("2026-05-06T11:37:11Z"), "2026-05-06T11:37:11Z");
    assert.equal(toIsoTime(undefined), undefined);
});

test("pagination reads only the fields that exist", () => {
    assert.deepEqual(pagination({ HasMore: false }, {}), { has_more: false });
    assert.deepEqual(pagination({ next_cursor: "abc" }, {}), { next_cursor: "abc" });
    assert.deepEqual(pagination({}, {}), {});
    // An empty cursor is not a cursor.
    assert.deepEqual(pagination({ NextCursor: "  " }, {}), {});
});

test("extraFields lists unprojected scalars and skips duplicated values", () => {
    // Only rendered values are deduplicated, never whole keys: a numeric
    // timestamp is still worth showing beside its ISO projection.
    const shown = new Set(["如何理解 RAVE 文化", item.Url, item.Excerpt, item.Author]);
    assert.deepEqual(extraFields(item, shown), [
        ["PublishTime", "1778494631"],
        ["VoteCount", "128"],
    ]);
});