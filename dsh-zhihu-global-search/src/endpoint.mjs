/**
 * Request shaping for one Zhihu global-search call: validate what the model
 * sent, clamp bounded numbers, and build the upstream URL.
 *
 * Every wire name (path, parameter names, allowed values) is concentrated in
 * this module: the public contract was reconstructed from secondary sources,
 * so a naming correction must stay a one-file change.
 */

/** Path of the global-search operation on the Zhihu Open Platform gateway. */
export const SEARCH_PATH = "/api/v1/content/global_search";

/** Default and maximum result counts accepted by the upstream endpoint. */
export const COUNT_DEFAULT = 10;
export const COUNT_MAX = 20;

/** Indexes the upstream accepts in `SearchDB`. */
export const SEARCH_DBS = Object.freeze(["all", "realtime", "static"]);

/**
 * A model-facing argument error: the call never reaches the network.
 * A dedicated class keeps the tool layer from confusing it with an upstream
 * failure (which the model cannot fix by editing arguments).
 */
export class ArgumentError extends Error {
    /**
     * @param {string} text - actionable message for the model.
     */
    constructor(text) {
        super(text);
        this.name = "ArgumentError";
        this.kind = "invalid_argument";
    }
}

/**
 * Clamp a requested result count into the upstream range.
 * Non-integers are truncated toward zero; missing values keep the default.
 * @param {unknown} value - `count` argument.
 * @returns {number} an integer in [1, COUNT_MAX].
 */
export function clampCount(value) {
    if (value === undefined || value === null || value === "") return COUNT_DEFAULT;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return COUNT_DEFAULT;
    return Math.min(COUNT_MAX, Math.max(1, Math.trunc(numeric)));
}

/**
 * Validate and normalize the model arguments into the upstream request shape.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {{ query: string, count: number, filter: string, searchDb: string,
 *   warnings: string[] }} normalized request.
 * @throws {ArgumentError} when the query is blank or `search_db` is unknown.
 */
export function normalizeRequest(args = {}) {
    const rawQuery = args.query;
    if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
        throw new ArgumentError("query 必须是非空字符串：请给出要搜索的关键词。");
    }
    const query = rawQuery.trim();

    /** @type {string[]} */
    const warnings = [];

    const requestedCount = args.count;
    const count = clampCount(requestedCount);
    if (requestedCount !== undefined && requestedCount !== null && requestedCount !== "") {
        const numeric = Number(requestedCount);
        if (!Number.isFinite(numeric) || Math.trunc(numeric) !== numeric || count !== numeric) {
            warnings.push(`count 已从 ${String(requestedCount)} 钳制为 ${count}（取值范围 1–${COUNT_MAX}）。`);
        }
    }

    let searchDb = "all";
    if (args.search_db !== undefined && args.search_db !== null && args.search_db !== "") {
        const candidate = String(args.search_db).trim().toLowerCase();
        if (!SEARCH_DBS.includes(candidate)) {
            throw new ArgumentError(
                `search_db 只接受 ${SEARCH_DBS.join(" / ")}，收到「${String(args.search_db)}」。`,
            );
        }
        searchDb = candidate;
    }

    const filter = typeof args.filter === "string" ? args.filter.trim() : "";
    return { query, count, filter, searchDb, warnings };
}

/**
 * Validate a configured gateway base URL at activation time.
 * @param {string} value - configured `baseURL`.
 * @returns {string} the normalized origin (no trailing slash).
 * @throws {Error} when the value is not an http(s) URL.
 */
export function normalizeBaseURL(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`baseURL 不是合法 URL：${JSON.stringify(value)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`baseURL 只支持 http/https，收到 ${url.protocol}`);
    }
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/**
 * Build the upstream request URL for one normalized request.
 *
 * Wire detail: the parameter names mirror the published documentation
 * (`Query`, `Count`, `Filter`, `SearchDB`). `Filter` is omitted when empty so
 * the upstream applies its own default instead of parsing an empty expression.
 * @param {string} baseURL - normalized gateway base URL.
 * @param {{ query: string, count: number, filter: string, searchDb: string }} request - normalized request.
 * @returns {URL} the request URL.
 */
export function buildUrl(baseURL, request) {
    const root = baseURL.replace(/\/+$/u, "");
    const url = new URL(`${root}${SEARCH_PATH}`);
    url.searchParams.set("Query", request.query);
    url.searchParams.set("Count", String(request.count));
    url.searchParams.set("SearchDB", request.searchDb);
    if (request.filter !== "") url.searchParams.set("Filter", request.filter);
    return url;
}