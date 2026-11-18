/**
 * Decode one global-search response without trusting its inner shape.
 *
 * The published documentation does not pin the field names inside `Data`, so
 * this module never assumes them:
 *  - the envelope is read only for `Code` / `Message`;
 *  - the item list is looked up in several known containers, and failing that a
 *    bare array response is used;
 *  - each item keeps its upstream object in `raw`, and a small candidate table
 *    projects title / url / snippet / author / time when those keys exist;
 *  - when no item can be located, `Data` itself is kept as a single `raw`
 *    entry, so no upstream content is silently dropped.
 */

/** Containers that may hold the item array, in preference order. */
const ITEM_CONTAINERS = ["Items", "items", "List", "list", "Results", "results", "Data", "data"];

/** Candidate keys per projected field; the first present non-empty value wins. */
const FIELD_KEYS = Object.freeze({
    title: ["Title", "title", "Name", "name", "QuestionTitle", "question_title"],
    url: ["Url", "url", "URL", "Link", "link", "SourceUrl", "source_url", "ShareUrl", "share_url"],
    snippet: [
        "Excerpt",
        "excerpt",
        "Summary",
        "summary",
        "Snippet",
        "snippet",
        "Description",
        "description",
        "Content",
        "content",
    ],
    author: ["Author", "author", "AuthorName", "author_name", "Creator", "creator", "UserName", "user_name"],
    publishedAt: [
        "PublishTime",
        "publish_time",
        "PublishedAt",
        "published_at",
        "Created",
        "created",
        "CreatedAt",
        "created_at",
        "Time",
        "time",
    ],
});

/**
 * Whether a value is a plain object (not null, not an array).
 * @param {unknown} value - candidate.
 * @returns {value is Record<string, unknown>} true for plain objects.
 */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pick the first usable value for a field from an upstream item.
 * @param {Record<string, unknown>} raw - upstream item.
 * @param {string[]} keys - candidate key names.
 * @returns {string | undefined} the value as text, or undefined.
 */
function pick(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim() !== "") return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return undefined;
}

/**
 * Convert a timestamp-shaped value into an ISO-8601 string when possible.
 * Upstream values may already be ISO strings or epoch seconds/milliseconds; an
 * unrecognized form is returned verbatim so nothing is invented.
 * @param {string | undefined} value - upstream time value.
 * @returns {string | undefined} ISO text or the original value.
 */
export function toIsoTime(value) {
    if (value === undefined) return undefined;
    if (/^\d{9,13}$/u.test(value)) {
        const numeric = Number(value);
        const ms = value.length <= 10 ? numeric * 1000 : numeric;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return value;
}

/**
 * Project one upstream item into the tool's item shape.
 * @param {unknown} raw - item as returned upstream.
 * @param {number} index - position, used only for a missing title.
 * @returns {{ title?: string, url?: string, snippet?: string, author?: string,
 *   published_at?: string, raw: unknown }} projected item.
 */
export function projectItem(raw, index) {
    if (!isRecord(raw)) {
        return { title: `结果 ${index + 1}`, raw };
    }
    /** @type {Record<string, string | undefined>} */
    const item = {};
    const title = pick(raw, FIELD_KEYS.title);
    const url = pick(raw, FIELD_KEYS.url);
    const snippet = pick(raw, FIELD_KEYS.snippet);
    const author = pick(raw, FIELD_KEYS.author);
    const publishedAt = toIsoTime(pick(raw, FIELD_KEYS.publishedAt));
    if (title !== undefined) item.title = title;
    if (url !== undefined) item.url = url;
    if (snippet !== undefined) item.snippet = snippet;
    if (author !== undefined) item.author = author;
    if (publishedAt !== undefined) item.published_at = publishedAt;
    item.raw = raw;
    return item;
}

/**
 * Locate the item array inside a response body.
 * @param {unknown} body - parsed JSON body.
 * @param {unknown} data - envelope `Data` (may be undefined).
 * @returns {unknown[] | undefined} the raw item list, when one exists.
 */
export function locateItems(body, data) {
    if (Array.isArray(data)) return data;
    if (isRecord(data)) {
        for (const key of ITEM_CONTAINERS) {
            if (Array.isArray(data[key])) return data[key];
        }
    }
    if (Array.isArray(body)) return body;
    return undefined;
}

/**
 * The located item list, or `undefined` when no container was recognized.
 * The distinction drives {@link buildOutput}: an empty container is an empty
 * result, while an unknown shape must be preserved verbatim.
 * @param {{ items: unknown[], data?: unknown, located?: boolean }} decoded - decoded response.
 * @returns {unknown[] | undefined} the item list when one exists.
 */
export function locatedItems(decoded) {
    return Array.isArray(decoded.items) ? decoded.items : locateItems(undefined, decoded.data);
}

/**
 * Read the pagination facts that exist, inventing nothing.
 * @param {unknown} data - envelope `Data`.
 * @param {unknown} body - parsed body (fallback source).
 * @returns {{ has_more?: boolean, next_cursor?: string }} present pagination fields.
 */
export function pagination(data, body) {
    /** @type {{ has_more?: boolean, next_cursor?: string }} */
    const page = {};
    for (const source of [data, body]) {
        if (!isRecord(source)) continue;
        if (page.has_more === undefined) {
            const more = source.HasMore ?? source.has_more;
            if (typeof more === "boolean") page.has_more = more;
        }
        if (page.next_cursor === undefined) {
            const cursor = source.NextCursor ?? source.next_cursor;
            if (typeof cursor === "string" && cursor.trim() !== "") page.next_cursor = cursor;
        }
    }
    return page;
}

/**
 * Decode one response body into the facts the search pipeline needs.
 * @param {{ status: number, text: string }} response - raw response.
 * @returns {{ status: number, code?: number, message?: string, data?: unknown,
 *   items: unknown[], has_more?: boolean, next_cursor?: string,
 *   json: boolean, body: string }} decoded response.
 */
export function decodeResponse(response) {
    /** @type {any} */
    let body;
    try {
        body = JSON.parse(response.text);
    } catch {
        return { status: response.status, items: [], json: false, body: response.text };
    }
    const envelope = isRecord(body) ? body : {};
    const rawCode = envelope.Code ?? envelope.code;
    const code = typeof rawCode === "number" ? rawCode : Number.isFinite(Number(rawCode)) && rawCode !== undefined
        ? Number(rawCode)
        : undefined;
    const message = envelope.Message ?? envelope.message;
    const data = envelope.Data ?? envelope.data;
    const items = locateItems(body, data);
    return {
        status: response.status,
        code: Number.isFinite(code) ? code : undefined,
        message: typeof message === "string" ? message : undefined,
        data,
        items,
        ...pagination(data ?? envelope, envelope),
        json: true,
        body: response.text,
    };
}

/**
 * Quote every scalar field of an upstream item that this module did not already
 * project, so the rendered text shows the whole record regardless of naming.
 * @param {unknown} raw - upstream item.
 * @param {Set<string>} shown - values already rendered.
 * @returns {Array<[string, string]>} extra `[key, value]` pairs.
 */
export function extraFields(raw, shown = new Set()) {
    if (!isRecord(raw)) return [];
    /** @type {Array<[string, string]>} */
    const extras = [];
    for (const [key, value] of Object.entries(raw)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "string") {
            const text = value.trim().replace(/\s+/gu, " ");
            if (text === "" || shown.has(text)) continue;
            extras.push([key, text]);
        } else if (typeof value === "number" || typeof value === "boolean") {
            const text = String(value);
            if (shown.has(text)) continue;
            extras.push([key, text]);
        }
    }
    return extras;
}