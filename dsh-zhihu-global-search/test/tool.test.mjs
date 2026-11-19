import assert from "node:assert/strict";
import { test } from "node:test";

const {
    DEFAULT_MAX_CHARS,
    maxCharsOf,
    OUTPUT_SCHEMA,
    PARAMETERS,
    presentationMeta,
    renderOutput,
    shortQuery,
    stringsFor,
} = await import("../src/tool.mjs");
const { buildOutput, renderMarkdown, sourcesOf } = await import("../src/result.mjs");
const { projectItem } = await import("../src/respond.mjs");

const raw = {
    Title: "问题标题",
    Url: "https://www.zhihu.com/question/1",
    Excerpt: "这是摘要内容",
    Author: "作者甲",
    PublishTime: 1_778_494_631,
    VoteCount: 42,
};

/**
 * Build a canonical output value through the real pipeline helpers.
 * @param {{ items?: unknown[], has_more?: boolean, next_cursor?: string, data?: unknown, warnings?: string[] }} decoded
 * @returns {Record<string, any>} output value.
 */
function value(decoded = {}) {
    return buildOutput(
        { query: "知乎 搜索", count: 10 },
        { items: decoded.items ?? [raw], has_more: decoded.has_more, next_cursor: decoded.next_cursor, data: decoded.data },
        decoded.warnings ?? [],
        { projectItem },
    );
}

/**
 * Validate a value against the JSON-Schema subset the registry enforces, for
 * the keywords this schema uses. Mirrors "additionalProperties: false" strictly.
 * @param {Record<string, any>} schema - schema node.
 * @param {unknown} candidate - value.
 * @param {string} path - diagnostic path.
 * @returns {string[]} violations.
 */
function validate(schema, candidate, path = "$") {
    /** @type {string[]} */
    const problems = [];
    if (schema.type === "object") {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
            return [`${path}: expected object`];
        }
        for (const key of schema.required ?? []) {
            if (!(key in candidate)) problems.push(`${path}.${key}: missing`);
        }
        const properties = schema.properties ?? {};
        for (const [key, child] of Object.entries(candidate)) {
            if (!(key in properties)) {
                if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`);
                continue;
            }
            problems.push(...validate(properties[key], child, `${path}.${key}`));
        }
    } else if (schema.type === "array") {
        if (!Array.isArray(candidate)) return [`${path}: expected array`];
        candidate.forEach((entry, index) => problems.push(...validate(schema.items ?? {}, entry, `${path}[${index}]`)));
    } else if (schema.type === "string" && typeof candidate !== "string") {
        problems.push(`${path}: expected string`);
    } else if (schema.type === "integer" && !Number.isInteger(candidate)) {
        problems.push(`${path}: expected integer`);
    } else if (schema.type === "boolean" && typeof candidate !== "boolean") {
        problems.push(`${path}: expected boolean`);
    }
    if (schema.enum && !schema.enum.includes(candidate)) problems.push(`${path}: not in enum`);
    return problems;
}

test("PARAMETERS follows the authoring DSL and declares the documented arguments", () => {
    assert.deepEqual(Object.keys(PARAMETERS).sort(), ["count", "filter", "max_chars", "query", "search_db"]);
    assert.equal(PARAMETERS.query.required, true);
    for (const [name, spec] of Object.entries(PARAMETERS)) {
        assert.equal(typeof spec.type, "string", name);
        assert.equal(typeof spec.description, "string", name);
    }
    assert.deepEqual(PARAMETERS.search_db.enum, ["all", "realtime", "static"]);
    // The DSL form, not a JSON-Schema object.
    assert.equal(PARAMETERS.query.properties, undefined);
});

test("the full output value validates against the declared schema", () => {
    const full = value({ has_more: true, next_cursor: "c1", warnings: ["note"] });
    assert.deepEqual(validate(OUTPUT_SCHEMA, full), []);
    assert.deepEqual(validate(OUTPUT_SCHEMA, value({ items: [] })), []);
    assert.deepEqual(validate(OUTPUT_SCHEMA, value({ data: { Opaque: 1 } })), []);
});

test("the output schema uses the tools value DSL, which defineTool compiles strictly", () => {
    // A root `required` ARRAY is raw JSON Schema; the DSL rejects it with a
    // JsonSchemaError that fails plugin activation. Requiredness is per property.
    assert.equal(OUTPUT_SCHEMA.required, undefined);
    assert.equal(OUTPUT_SCHEMA.additionalProperties, false);
    for (const [name, child] of Object.entries(OUTPUT_SCHEMA.properties)) {
        assert.equal(typeof child.type, "string", name);
        assert.ok(!("required" in child) || child.required === true, `${name}.required must be the authoring marker`);
    }
    const item = OUTPUT_SCHEMA.properties.items.items;
    assert.equal(item.additionalProperties, false);
    assert.equal(item.properties.raw.type, "json");
    assert.equal(item.properties.raw.required, true);
});

test("the schema rejects an unexpected key, which is why both are kept in lockstep", () => {
    const sneaky = { ...value(), extra: 1 };
    assert.deepEqual(validate(OUTPUT_SCHEMA, sneaky), ["$.extra: not allowed"]);
});

test("renderOutput lists items with links, metadata and unprojected fields", () => {
    const text = renderOutput({}, value())[0].text;
    assert.match(text, /^## 知乎全网搜索：知乎 搜索/u);
    assert.match(text, /1\. 问题标题/u);
    assert.match(text, /链接：https:\/\/www\.zhihu\.com\/question\/1/u);
    assert.match(text, /作者甲 · 2026-05-11T10:17:11\.000Z/u);
    assert.match(text, /摘要：这是摘要内容/u);
    assert.match(text, /VoteCount=42/u);
});

test("an empty result says so instead of rendering nothing", () => {
    const text = renderOutput({}, value({ items: [] }))[0].text;
    assert.match(text, /没有找到与「知乎 搜索」相关的结果/u);
});

test("max_chars cuts at item boundaries and flips truncated", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ Title: `第 ${index} 条`, Excerpt: "很长的摘要".repeat(40) }));
    const output = value({ items });
    const text = renderOutput({ max_chars: 300 }, output)[0].text;
    assert.equal(output.truncated, true);
    assert.match(text, /已截断/u);
    assert.ok(text.length < 1_600, `unexpectedly long: ${text.length}`);
});

test("has_more without a cursor is reported without inventing one", () => {
    const output = value({ has_more: true });
    const text = renderMarkdown(output, DEFAULT_MAX_CHARS);
    assert.match(text, /还有更多结果/u);
    assert.match(text, /未提供翻页参数/u);
    assert.equal(output.next_cursor, undefined);
});

test("renderOutput never throws on a partially populated value", () => {
    const sparse = { query: "q", count: 0, items: [{ raw: {} }], truncated: false, warnings: [] };
    assert.doesNotThrow(() => renderOutput({}, sparse));
    assert.match(renderOutput({}, sparse)[0].text, /1\. 结果 1/u);
});

test("presentationMeta projects citation-shaped sources and never the secret", () => {
    const meta = presentationMeta({}, value());
    assert.deepEqual(meta.sources, [
        {
            url: "https://www.zhihu.com/question/1",
            title: "问题标题",
            snippet: "这是摘要内容",
            publishedAt: "2026-05-11T10:17:11.000Z",
        },
    ]);
    assert.equal(meta.truncated, false);
    assert.equal(sourcesOf({ items: [{ raw: {} }] }).length, 0);
});

test("shortQuery collapses whitespace and bounds the label", () => {
    assert.equal(shortQuery("  a \n b  "), "a b");
    assert.equal(shortQuery(""), "…");
    assert.equal(shortQuery("x".repeat(100)).length, 41);
    assert.equal(shortQuery(undefined), "…");
});

test("maxCharsOf accepts positive integers only", () => {
    assert.equal(maxCharsOf({}), DEFAULT_MAX_CHARS);
    assert.equal(maxCharsOf({ max_chars: 500 }), 500);
    assert.equal(maxCharsOf({ max_chars: 0 }), DEFAULT_MAX_CHARS);
    assert.equal(maxCharsOf({ max_chars: -5 }), DEFAULT_MAX_CHARS);
    assert.equal(maxCharsOf({ max_chars: 1.5 }), DEFAULT_MAX_CHARS);
    assert.equal(maxCharsOf({ max_chars: "900" }), DEFAULT_MAX_CHARS);
});

test("the description states the preference over the built-in web_search", () => {
    // The built-in web_search describes itself only as "search the web for
    // current information", so an equally plain description loses the tie. The
    // preference must be explicit, name the fallback, and stay one line of
    // guidance the model can act on (mirrors `md_article` vs `web_fetch`).
    const description = stringsFor("zh-CN").description;
    assert.match(description, /Prefer it over web_search/iu);
    assert.match(description, /fall back to web_search only if it fails/iu);
    // The reason must be concrete, not a bare assertion of superiority.
    assert.match(description, /links and dates/u);
    assert.match(description, /filter/u);
});

test("the description stays short, like md_article's", () => {
    // `md_article` states capability + preference + knobs in ~300 characters.
    // A longer description buys no priority and buries the preference line, so
    // the ceiling is enforced here rather than left to taste.
    const description = stringsFor("zh-CN").description;
    assert.ok(description.length <= 500, `description is ${description.length} chars; keep it near md_article's ~300`);
    assert.ok(description.split(". ").length <= 4, "one sentence each for capability, preference, and knobs");
    // Every parameter the description promises must exist.
    for (const hint of ["count", "filter", "search_db"]) assert.match(description, new RegExp(hint, "u"));
});

test("stringsFor picks a table by locale and both tables describe the tool", () => {
    // The model-facing description stays English in every locale; only the
    // presentation labels follow the locale.
    assert.match(stringsFor("zh-CN").description, /Zhihu Open Platform/u);
    assert.equal(stringsFor("en-US").description, stringsFor("zh-CN").description);
    // An unknown locale follows the English table, exactly like the harness default.
    assert.equal(stringsFor(undefined).presentSearching("q"), "Zhihu global search · q");
    assert.equal(stringsFor("zh-CN").presentSearching("q"), "知乎全网搜索 · q");
    assert.equal(stringsFor("en").presentSearching("q"), "Zhihu global search · q");
});