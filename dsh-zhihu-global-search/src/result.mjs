/**
 * Render one successful search result the way the model (and a UI) reads it.
 *
 * The render is bounded by `max_chars` at item boundaries so a long upstream
 * payload cannot flood the context. Nothing here may throw: the output render
 * is the last step of a tool call and an exception would replace the result.
 */
import { extraFields } from "./respond.mjs";

/** Longest snippet kept per item before the next item takes the budget. */
const SNIPPET_CHARS = 600;

/**
 * Collapse whitespace and truncate one free-text field.
 * @param {string} value - text.
 * @param {number} limit - maximum characters.
 * @returns {string} flattened text.
 */
function flatten(value, limit = SNIPPET_CHARS) {
    const text = String(value).replace(/\s+/gu, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Turn the decoded response into the canonical output value.
 *
 * When no item list can be located, the envelope `Data` becomes one `raw` item:
 * an unrecognized shape must still reach the model verbatim, because guessing a
 * field name is worse than showing the payload.
 * @param {{ query: string, count: number }} request - normalized request.
 * @param {{ items?: unknown[], itemsLocated?: boolean, has_more?: boolean,
 *   next_cursor?: string, data?: unknown }} decoded - decoded response.
 * @param {string[]} warnings - warnings collected so far.
 * @param {{ projectItem: (raw: unknown, index: number) => Record<string, unknown> }} port - projection helpers.
 * @returns {Record<string, unknown>} the tool output value (schema-conformant).
 */
export function buildOutput(request, decoded, warnings, port) {
    /** @type {string[]} */
    const notes = [...warnings];
    let raws = Array.isArray(decoded.items)
        ? decoded.items
        : decoded.itemsLocated === true
          ? []
          : undefined;
    if (raws === undefined && decoded.data !== undefined) {
        notes.push("上游没有返回可识别的条目结构；已把原始 Data 保留在 items[0].raw 中。");
        raws = [decoded.data];
    } else if (raws === undefined) {
        raws = [];
    }
    const items = raws.map((raw, index) => port.projectItem(raw, index));
    return {
        query: request.query,
        count: request.count,
        items,
        ...(decoded.has_more !== undefined ? { has_more: decoded.has_more } : {}),
        ...(decoded.next_cursor !== undefined ? { next_cursor: decoded.next_cursor } : {}),
        truncated: false,
        warnings: notes,
    };
}

/**
 * Render the output value as Markdown for the model.
 * Also flips `truncated` on the value when the text budget cut the list.
 * @param {Record<string, any>} value - tool output value (mutable, owned here).
 * @param {number} maxChars - text budget.
 * @returns {string} Markdown text.
 */
export function renderMarkdown(value, maxChars) {
    const header = [`## 知乎全网搜索：${value.query}`, ""];
    if (value.items.length === 0) {
        const lines = [...header, `没有找到与「${value.query}」相关的结果。`];
        for (const warning of value.warnings ?? []) lines.push("", `> ${warning}`);
        return lines.join("\n");
    }
    /** @type {string[]} */
    const blocks = [];
    let used = header.join("\n").length;
    let rendered = 0;
    for (const [index, item] of value.items.entries()) {
        const lines = [`${index + 1}. ${item.title ?? `结果 ${index + 1}`}`];
        if (item.url) lines.push(`   - 链接：${item.url}`);
        const meta = [item.author, item.published_at].filter(Boolean).join(" · ");
        if (meta) lines.push(`   - ${meta}`);
        if (item.snippet) lines.push(`   - 摘要：${flatten(item.snippet)}`);
        const shown = new Set([item.title, item.url, item.snippet, item.author, item.published_at].filter(Boolean));
        const extras = extraFields(item.raw, shown);
        if (extras.length > 0) {
            lines.push(`   - 其他字段：${extras.map(([key, text]) => `${key}=${flatten(text, 120)}`).join("; ")}`);
        }
        const block = lines.join("\n");
        if (used + block.length + 2 > maxChars && rendered > 0) {
            value.truncated = true;
            blocks.push(`……（已截断：共 ${value.items.length} 条，仅显示前 ${rendered} 条）`);
            break;
        }
        blocks.push(block);
        used += block.length + 2;
        rendered += 1;
    }
    /** @type {string[]} */
    const footer = [];
    if (value.has_more === true) {
        footer.push("", `> 上游标记还有更多结果${value.next_cursor ? `（cursor: ${value.next_cursor}）` : "（未提供翻页参数）"}。`);
    }
    if (value.truncated) footer.push("", "> 结果文本已按 max_chars 截断。");
    for (const warning of value.warnings ?? []) footer.push("", `> ${warning}`);
    return [...header, blocks.join("\n\n"), ...footer].join("\n");
}

/**
 * Project the citation-shaped sources for a capable UI.
 * @param {Record<string, any>} value - tool output value.
 * @returns {{ url: string, title?: string, snippet?: string, publishedAt?: string }[]} citable sources.
 */
export function sourcesOf(value) {
    /** @type {{ url: string, title?: string, snippet?: string, publishedAt?: string }[]} */
    const sources = [];
    for (const item of value.items ?? []) {
        if (typeof item.url !== "string" || item.url === "") continue;
        /** @type {Record<string, string>} */
        const source = { url: item.url };
        if (item.title) source.title = item.title;
        if (item.snippet) source.snippet = flatten(item.snippet, 200);
        if (item.published_at) source.publishedAt = item.published_at;
        sources.push(source);
    }
    return sources;
}