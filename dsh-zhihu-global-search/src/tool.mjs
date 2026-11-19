/**
 * Model-facing declaration for the `zhihu_global_search` tool: description
 * text, parameter spec, output schema, and presentation projections.
 *
 * Both halves use `defineTool`'s VALUE SCHEMA DSL, not raw JSON Schema: the
 * parameter map marks required keys with `required: true` (compiled into the
 * parent's `required` array), and the output schema uses the same node keywords.
 * A DSL mistake throws `JsonSchemaError` during `apply()`, which fails
 * activation and leaves the tool unregistered.
 */
import { renderMarkdown, sourcesOf } from "./result.mjs";

/** Default text budget for the rendered result, in characters. */
export const DEFAULT_MAX_CHARS = 12_000;

/** Parameter spec passed to `defineTool`. */
export const PARAMETERS = {
    query: {
        type: "string",
        required: true,
        description: "Search keywords. Must not be blank; surrounding whitespace is trimmed.",
    },
    count: {
        type: "integer",
        description: "Number of results, clamped to 1–20 (default 10). Out-of-range values are clamped, not rejected.",
    },
    filter: {
        type: "string",
        description:
            "Upstream filter expression, passed through unchanged. Example: host==\"example.com\" AND " +
            "publish_time>=1778494631. The plugin does not validate its syntax.",
    },
    search_db: {
        type: "string",
        enum: ["all", "realtime", "static"],
        description: "Upstream index: all (default), realtime, or static.",
    },
    max_chars: {
        type: "integer",
        description: `Text budget for the rendered result in characters (default ${DEFAULT_MAX_CHARS}). ` +
            "Items past the budget are dropped and the result reports truncated: true.",
    },
};

/**
 * Canonical output schema for `zhihu_global_search` results.
 *
 * This is the tools VALUE SCHEMA DSL, not raw JSON Schema: `required` is not a
 * node keyword there (a root `required` array makes `defineTool` throw
 * `JsonSchemaError` and the entry fails to activate). Requiredness is expressed
 * per property with `required: true`, which the compiler hoists into the
 * parent's `required` list.
 *
 * `additionalProperties: false` is deliberate: an accidental extra key would be
 * silently stripped by the registry, so the schema and the value shape are kept
 * in lockstep by `test/tool.test.mjs`.
 *
 * Optional fields are simply properties without the `required: true` marker:
 * the DSL has no separate optional syntax, and the registry validates whatever
 * shape the tool actually returns.
 */
export const OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        query: { type: "string", required: true },
        count: { type: "integer", required: true },
        items: {
            type: "array",
            required: true,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                    snippet: { type: "string" },
                    author: { type: "string" },
                    published_at: { type: "string" },
                    raw: { type: "json", required: true },
                },
            },
        },
        has_more: { type: "boolean" },
        next_cursor: { type: "string" },
        truncated: { type: "boolean", required: true },
        warnings: { type: "array", items: { type: "string" }, required: true },
    },
};

/**
 * @typedef {{ description: string, presentSearching: (query: string) => string,
 *   presentResultFailed: string, presentResultDone: (count: number) => string }} Strings
 */

/** @type {Strings} */
const ZH = Object.freeze({
    description: [
        "Search the whole web through the Zhihu Open Platform global search API, returning a ranked list with titles,",
        "links, authors, timestamps and snippets, covering Zhihu answers, Zhihu articles, news and other sites.",
        "It returns the underlying sources with links and dates, not just a",
        "summary and a URL list, and it supports host and time filtering via `filter`.",
    ].join(" "),
    presentSearching: (query) => `知乎全网搜索 · ${query}`,
    presentResultFailed: "知乎全网搜索失败",
    presentResultDone: (count) => `知乎全网搜索 · ${count} 条结果`,
});

/** @type {Strings} */
const EN = Object.freeze({
    description: ZH.description,
    presentSearching: (query) => `Zhihu global search · ${query}`,
    presentResultFailed: "Zhihu global search failed",
    presentResultDone: (count) => `Zhihu global search · ${count} results`,
});

/**
 * Pick the text table for a locale tag.
 * @param {string | undefined} locale - DSH locale, e.g. `zh-CN` or `en`.
 * @returns {Strings} text table.
 */
export function stringsFor(locale) {
    return String(locale ?? "")
        .toLowerCase()
        .startsWith("zh")
        ? ZH
        : EN;
}

/**
 * Short display label: the query, whitespace-collapsed and bounded.
 * @param {unknown} query - raw query argument.
 * @param {number} [limit] - maximum characters.
 * @returns {string} label.
 */
export function shortQuery(query, limit = 40) {
    const text = String(query ?? "")
        .replace(/\s+/gu, " ")
        .trim();
    if (text === "") return "…";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * The text budget requested by the arguments.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {number} a positive character budget.
 */
export function maxCharsOf(args) {
    const value = args?.max_chars;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CHARS;
}

/**
 * Render callback shared by `output.render` and tests.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {Record<string, any>} value - canonical output value.
 * @returns {Array<{ type: "text", text: string }>} content blocks.
 */
export function renderOutput(args, value) {
    return [{ type: "text", text: renderMarkdown(value, maxCharsOf(args)) }];
}

/**
 * Presentation metadata for a capable UI: a title plus citation-shaped sources.
 * Must stay a pure function of the value — it is replayed with logged data.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {Record<string, any>} value - canonical output value.
 * @returns {{ title: string, sources: ReturnType<typeof sourcesOf>, truncated: boolean }} metadata.
 */
export function presentationMeta(_args, value) {
    return {
        title: ZH.presentResultDone(value.items?.length ?? 0),
        sources: sourcesOf(value ?? {}),
        truncated: value?.truncated === true,
    };
}
