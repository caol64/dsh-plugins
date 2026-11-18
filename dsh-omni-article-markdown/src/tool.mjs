/**
 * Model-facing declaration for the `md_article` tool: description text,
 * parameter spec, and output schema.
 *
 * The parameter spec follows `defineTool`'s authoring DSL (a property map whose
 * keys carry `required: true`); `defineTool` compiles it into the wire JSON
 * Schema. The output schema is the enforced JSON Schema subset.
 */
import { TRUNCATE_MIN_VERSION } from "./env.mjs";

/** Parameter spec passed to `defineTool`. */
export const PARAMETERS = {
    url: {
        type: "string",
        required: true,
        description:
            "Article URL, or a path to a local .html file. Relative paths resolve against the working directory.",
    },
    max_tokens: {
        type: "integer",
        description:
            "Truncate the Markdown to approximately this many tokens (mdcli --truncate, heuristic estimate). " +
            "Omit to return the whole article; 800 reproduces mdcli's own default.",
    },
    save: {
        type: "string",
        description:
            "Save the result instead of returning it: a directory (file name comes from the article title) " +
            "or a full file path. Relative paths resolve against the working directory.",
    },
    no_verify_ssl: {
        type: "boolean",
        description: "Skip SSL certificate verification. Only for targets with a broken certificate chain.",
    },
    raw_html: {
        type: "boolean",
        description:
            "Return the raw fetched HTML (mdcli read) instead of Markdown, for debugging whether a page is a JS shell. " +
            "max_tokens does not apply in this mode.",
    },
    prettify: {
        type: "boolean",
        description: "With raw_html, pretty-print the HTML.",
    },
};

/** Canonical output schema for `md_article` results. */
export const OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        markdown: { type: "string" },
        saved_path: { type: "string" },
        truncated: { type: "boolean" },
        mode: { type: "string", enum: ["markdown", "saved", "raw_html"] },
        warnings: { type: "array", items: { type: "string" } },
    },
};

/**
 * @typedef {{ description: string, notInstalled: string, installFailed: string,
 *   installRunning: string, browserFixed: string, oldVersion: (version: string) => string,
 *   emptyOutput: string, invalidUrl: string, targetNotFound: (path: string) => string,
 *   badScheme: (scheme: string) => string,
 *   retryFailed: (first: string, second: string) => string,
 *   saveUnknown: (dir: string) => string, truncateIgnored: string,
 *   presentFetching: (target: string) => string, presentSaving: (target: string) => string,
 *   presentRaw: (target: string) => string,
 *   presentResultSaved: (path: string, truncated: boolean) => string,
 *   presentResultFailed: string }} Strings
 */

/** @type {Strings} */
const ZH = Object.freeze({
    description: [
        "Convert one web article (blog, news, docs) into clean, de-noised Markdown with the 墨探 / mdcli converter.",
        "Use it instead of fetching and extracting by hand whenever a page or URL should become Markdown or its main text extracted,",
        "including when the user mentions mdcli or 墨探. JS-rendered and anti-bot sites switch to a browser automatically;",
        "images become absolute URLs, code fences and GFM tables are preserved.",
        "Long articles are truncated at safe block boundaries with --truncate, or saved to disk with save.",
    ].join(" "),
    notInstalled:
        "mdcli 未安装，且插件禁用或不允许自动安装（allowInstall=false）。请先运行 pipx install omni-article-markdown（或 uv tool install omni-article-markdown）后重试。",
    installFailed:
        "mdcli 未安装且自动安装失败。请手动安装：pipx install omni-article-markdown（或 uv tool install omni-article-markdown）。详情：",
    installRunning: "首次使用：正在安装 mdcli，可能需要一两分钟。",
    browserFixed: "已自动安装 Playwright Chromium 并重试成功。",
    oldVersion: (version) =>
        `当前 mdcli 版本 ${version} 不支持 --truncate（需要 >= ${TRUNCATE_MIN_VERSION}）。请升级：uv tool upgrade omni-article-markdown（或 pipx upgrade omni-article-markdown），或先不传 max_tokens。`,
    emptyOutput: "mdcli 成功退出但没有输出任何内容。按提取失败处理：该页可能不是文章内容页。",
    invalidUrl: "url 必须是非空字符串（文章 URL 或本地 HTML 文件路径）。",
    targetNotFound: (path) => `本地文件不存在：${path}。相对路径按当前工作目录解析。`,
    badScheme: (scheme) => `不支持的 URL 协议「${scheme}」：只接受 http:// 或 https://，本地 HTML 请直接传文件路径。`,
    retryFailed: (first, second) => `已自动重试一次仍失败。首次错误：${first}；重试错误：${second}`,
    saveUnknown: (dir) => `mdcli 报告保存成功但未给出路径；请在 ${dir} 下查找 .md 文件。`,
    truncateIgnored: "raw_html 模式不支持 max_tokens，截断参数已忽略。",
    presentFetching: (target) => `墨探 · 正在转换 ${target}`,
    presentSaving: (target) => `墨探 · 正在转换并保存 ${target}`,
    presentRaw: (target) => `墨探 · 正在读取 HTML ${target}`,
    presentResultSaved: (path, truncated) => `已保存到 ${path}${truncated ? "（已截断）" : ""}`,
    presentResultFailed: "转换失败",
});

/** @type {Strings} */
const EN = Object.freeze({
    description: ZH.description,
    notInstalled:
        "mdcli is not installed and automatic installation is disabled. Run pipx install omni-article-markdown (or uv tool install omni-article-markdown) and retry.",
    installFailed:
        "mdcli is not installed and automatic installation failed. Install it manually with pipx install omni-article-markdown or uv tool install omni-article-markdown. Details: ",
    installRunning: "First use: installing mdcli, this can take a minute or two.",
    browserFixed: "Installed Playwright Chromium automatically and retried successfully.",
    oldVersion: (version) =>
        `mdcli ${version} does not support --truncate (requires >= ${TRUNCATE_MIN_VERSION}). Upgrade with uv tool upgrade omni-article-markdown (or pipx upgrade omni-article-markdown), or omit max_tokens.`,
    emptyOutput:
        "mdcli exited successfully but produced no output. Treat it as an extraction failure: the page is probably not an article page.",
    invalidUrl: "url must be a non-empty string (article URL or local HTML path).",
    targetNotFound: (path) => `Local file not found: ${path}. Relative paths resolve against the working directory.`,
    badScheme: (scheme) =>
        `Unsupported URL scheme "${scheme}": use http:// or https://, or pass a local HTML file path.`,
    retryFailed: (first, second) => `Retried once and still failed. First error: ${first}; retry error: ${second}`,
    saveUnknown: (dir) => `mdcli reported a successful save without a path; look for a .md file under ${dir}.`,
    truncateIgnored: "Truncation is not available for raw_html; max_tokens was ignored.",
    presentFetching: (target) => `Omni article · converting ${target}`,
    presentSaving: (target) => `Omni article · converting and saving ${target}`,
    presentRaw: (target) => `Omni article · reading HTML ${target}`,
    presentResultSaved: (path, truncated) => `Saved to ${path}${truncated ? " (truncated)" : ""}`,
    presentResultFailed: "Conversion failed",
});

/**
 * Pick the guidance table for a locale tag.
 * @param {string | undefined} locale - DSH locale, e.g. `zh-CN` or `en`.
 * @returns {Strings} guidance table.
 */
export function stringsFor(locale) {
    return String(locale ?? "")
        .toLowerCase()
        .startsWith("zh")
        ? ZH
        : EN;
}

/**
 * A short display label for a target: host for URLs, file name for paths.
 * @param {string} target - URL or path as given by the model.
 * @returns {string} compact label.
 */
export function shortLabel(target) {
    if (/^https?:\/\//iu.test(target)) {
        try {
            return new URL(target).host;
        } catch {
            return target;
        }
    }
    return target.split(/[\\/]/u).filter(Boolean).at(-1) ?? target;
}
