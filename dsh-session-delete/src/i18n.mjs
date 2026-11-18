/**
 * Host-side failure text, for the log line and for a client without its own
 * dictionary. The client half carries the authoritative localized strings for
 * the menu; these exist so a host log never says only "failed".
 *
 * Chinese is the default language, matching the rest of this repository.
 *
 * @module dsh-session-delete/i18n
 */

/** @typedef {Record<string, string>} Dict */

/** @type {Readonly<Record<string, Dict>>} */
export const HOST_TEXT = Object.freeze({
    "zh-CN": {
        "error.invalid-id": "会话 ID 不合法，已拒绝删除。",
        "error.session-not-found": "该会话已不存在。",
        "error.agent-busy": "该会话正在运行，当前配置不允许删除运行中的会话。",
        "error.agent-stuck": "该会话的运行没有在限定时间内停止，未删除任何文件。",
        "error.denied-path": "无法确认该会话的文件归属，为安全起见未删除任何文件。",
        "error.delete-failed": "删除会话文件时出错，可能只删除了一部分。",
        "error.internal": "删除会话时发生意外错误。",
        "done": "已删除会话。",
        "doneWithWarnings": "会话文件已删除，但有少量收尾步骤失败。",
    },
    en: {
        "error.invalid-id": "That is not a valid session id; nothing was deleted.",
        "error.session-not-found": "That session no longer exists.",
        "error.agent-busy": "That session is running and this profile forbids deleting running sessions.",
        "error.agent-stuck": "The running turn did not stop in time; nothing was deleted.",
        "error.denied-path": "Could not prove which files belong to that session; nothing was deleted.",
        "error.delete-failed": "Deleting the session files failed; some files may be gone.",
        "error.internal": "Deleting the session failed unexpectedly.",
        "done": "Session deleted.",
        "doneWithWarnings": "The session files are gone; a few cleanup steps failed.",
    },
});

/**
 * Pick the dictionary for a locale tag, falling back to Chinese.
 * @param {unknown} locale - the active locale tag, when the host exposes one.
 * @returns {Dict} the matching dictionary.
 */
export function stringsFor(locale) {
    const tag = typeof locale === "string" ? locale.toLowerCase() : "";
    if (tag.startsWith("en")) return HOST_TEXT.en;
    return HOST_TEXT["zh-CN"];
}

/**
 * Render one key through a dictionary, falling back to the key itself.
 * @param {Dict} dict - the chosen dictionary.
 * @param {string} key - the failure code or result key.
 * @returns {string} display text.
 */
export function translate(dict, key) {
    return dict[key] ?? key;
}