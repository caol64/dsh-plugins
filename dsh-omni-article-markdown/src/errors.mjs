/**
 * Turn mdcli failures into model-actionable guidance, mirroring the failure
 * table in the original skill (extraction failure, timeouts, SSL, noise).
 */
import { TRUNCATE_MIN_VERSION } from "./env.mjs";

/** Issue tracker the skill tells users to report unsupported sites to. */
export const ISSUE_URL = "https://github.com/caol64/omni-article-markdown/issues";

/** Failure categories understood by {@link classifyFailure}. */
export const FAILURE_KINDS = Object.freeze({
    extract: "extract",
    browser: "browser",
    timeout: "timeout",
    ssl: "ssl",
    empty: "empty",
    unsupportedOption: "unsupported-option",
    other: "other",
});

/**
 * @typedef {{ kind: string, retryable: boolean, message: string }} ClassifiedFailure
 */

/**
 * Classify one mdcli failure.
 * @param {string} message - mdcli `Error:` text (or a timeout marker).
 * @param {{ kind?: string }} [context] - extra classification input.
 * @returns {ClassifiedFailure} category, whether one retry may help, and the guidance text.
 */
export function classifyFailure(message, context = {}) {
    const text = String(message ?? "");
    const lower = text.toLowerCase();

    if (context.kind === "timeout") {
        return {
            kind: FAILURE_KINDS.timeout,
            retryable: true,
            message:
                "mdcli 调用超时。动态渲染站点（首次启动 Playwright/Chromium）或网络较慢时常见；可稍后重试，" +
                "或对本地已保存的 HTML 文件使用 md_article（url 传文件路径）离线转换。",
        };
    }
    if (/playwright|chromium|executable doesn't exist|browser.*(not|un)install/i.test(text)) {
        return {
            kind: FAILURE_KINDS.browser,
            retryable: false,
            message:
                "浏览器渲染不可用。插件已尝试自动安装 Chromium；仍失败时请在终端运行：" +
                "python -m playwright install chromium（使用 mdcli 所在虚拟环境的 Python）。",
        };
    }
    if (/failed to extract article content/i.test(text)) {
        return {
            kind: FAILURE_KINDS.extract,
            retryable: false,
            message:
                "该页不适合作为文章提取（列表页/纯 JS 空壳/非内容页）。先用 md_article 带 raw_html: true 确认 HTML 是否含正文：" +
                "若 HTTP 返回的 HTML 里本来就找不到正文文字，说明是动态渲染站点，直接正常调用 md_article 即可（会自动启用浏览器）；" +
                "确属不支持的站点时，向用户说明并改用其他方式获取内容。",
        };
    }
    if (/ssl|certificate/i.test(lower)) {
        return {
            kind: FAILURE_KINDS.ssl,
            retryable: true,
            message: "SSL 证书校验失败。若确认目标站证书链异常，可设 no_verify_ssl: true 重试（不推荐）。",
        };
    }
    if (/timeout|timed out|etimedout|connection reset|network is unreachable/i.test(lower)) {
        return {
            kind: FAILURE_KINDS.timeout,
            retryable: true,
            message: "网络超时或连接中断，可重试一次；对已知动态站点首次运行较慢属正常。",
        };
    }
    if (/no such option|unsupported option|--truncate/i.test(lower) && /option/i.test(lower)) {
        return {
            kind: FAILURE_KINDS.unsupportedOption,
            retryable: false,
            message:
                `当前 mdcli 不支持 --truncate（需要 >= ${TRUNCATE_MIN_VERSION}）。升级：uv tool upgrade omni-article-markdown` +
                "（或 pipx upgrade omni-article-markdown），或先不传 max_tokens。",
        };
    }
    return {
        kind: FAILURE_KINDS.other,
        retryable: false,
        message: `mdcli 失败：${text || "(无错误信息)"}。若只是输出混入导航/推荐等噪音，可把该 URL 反馈到项目 Issue：${ISSUE_URL}`,
    };
}

/**
 * Whether a classified failure is worth exactly one automatic retry.
 * @param {ClassifiedFailure} failure - classification result.
 * @returns {boolean} retry decision.
 */
export function shouldRetry(failure) {
    return failure.retryable === true;
}
