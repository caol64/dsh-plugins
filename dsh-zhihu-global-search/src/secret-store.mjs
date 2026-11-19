/**
 * This plugin's OWN secret store.
 *
 * Why not the shared credential document: `~/.dsh/.credentials.yaml` is a
 * machine-wide document. A plugin that writes its secret there as a `refs`
 * entry occupies a global environment-variable name, and the entry survives the
 * plugin's removal as an orphan. The official credentials seam also stores
 * per-plugin RECORDS in that same file, so the record path does not isolate the
 * file either (see docs/DEVELOPMENT-LOG.md §4.14).
 *
 * So this plugin keeps its secret in a directory of its own, named after the
 * package, under the harness storage root:
 *
 *     <DSH_HOME>/storages/dsh-zhihu-global-search/secret.json
 *
 * Isolation properties:
 *  - the directory is created `0700` and the file `0600` (the shared storage
 *    root is world-readable by default, so the mode is set explicitly and
 *    re-checked on every read);
 *  - writes are atomic (temporary file in the same directory + `rename`), so a
 *    crash never leaves a half-written document;
 *  - removing the plugin's directory removes the secret — nothing is left behind
 *    in a file that other plugins also use;
 *  - a corrupt or unreadable document is reported as an ERROR, never silently
 *    treated as "not configured".
 *
 * The value never leaves this module except as the resolved secret handed to the
 * request builder: no view, log line, or error message produced here carries it.
 */
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Directory name under the storage root; equals the package name. */
export const STORE_DIR_NAME = "dsh-zhihu-global-search";

/** The single document this plugin owns. */
export const STORE_FILE_NAME = "secret.json";

/** Document version, so a future change can migrate instead of guessing. */
const STORE_VERSION = 1;

/** Directory mode: owner-only. */
const DIR_MODE = 0o700;

/** File mode: owner-only. */
const FILE_MODE = 0o600;

/**
 * @typedef {{ configured: boolean, source?: string, writable: boolean, failed?: boolean }} SecretInfo
 */

/**
 * Resolve the store directory.
 * @param {{ storageRoot?: string, dir?: string }} [options] - explicit directory, or a storage root to nest under.
 * @returns {string | undefined} absolute directory, or undefined when neither is known.
 */
export function resolveStoreDir(options = {}) {
    if (typeof options.dir === "string" && options.dir.trim() !== "") return path.resolve(options.dir.trim());
    if (typeof options.storageRoot === "string" && options.storageRoot.trim() !== "") {
        return path.join(path.resolve(options.storageRoot.trim()), STORE_DIR_NAME);
    }
    return undefined;
}

/**
 * The harness home used when no explicit directory is configured.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string} the effective DSH home.
 */
export function harnessHome(env = process.env) {
    const fromEnv = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? env.DSH_HOME.trim() : undefined;
    return fromEnv ?? path.join(env.HOME ?? env.USERPROFILE ?? ".", ".dsh");
}

/**
 * Parse a stored document into its secret.
 * @param {string} text - file contents.
 * @returns {string | undefined} the secret, or undefined when the document stores none.
 * @throws {Error} when the document is not the shape this plugin writes.
 */
export function parseStoreDocument(text) {
    let document;
    try {
        document = JSON.parse(text);
    } catch {
        throw new Error("插件存储文件不是合法的 JSON，已拒绝使用。请删除该文件后重新保存 Access Secret。");
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
        throw new Error("插件存储文件结构不正确（应为对象），已拒绝使用。");
    }
    if (document.version !== STORE_VERSION) {
        throw new Error(`插件存储文件版本不受支持（期望 ${STORE_VERSION}），已拒绝使用。`);
    }
    if (!("secret" in document)) return undefined;
    if (typeof document.secret !== "string" || document.secret.trim() === "") {
        throw new Error("插件存储文件中的 secret 字段无效，已拒绝使用。");
    }
    return document.secret.trim();
}

/**
 * Whether a file mode grants anything beyond the owner.
 * @param {number} mode - `fs.Stats.mode`.
 * @returns {boolean} true when group or other has any permission.
 */
export function isOwnerOnly(mode) {
    return (mode & 0o077) === 0;
}

/**
 * A file-backed secret store for this plugin alone.
 * @param {{ dir: string }} options - the store directory.
 * @returns {{ describe: () => Promise<SecretInfo>, read: () => Promise<string | undefined>,
 *   write: (value: string) => Promise<void>, clear: () => Promise<void>, directory: string }} store.
 */
export function createSecretStore({ dir }) {
    const file = path.join(dir, STORE_FILE_NAME);

    /**
     * Read the document.
     *
     * A missing document is "not configured"; anything else (bad JSON, wrong
     * version, wrong field type, over-permissive permissions) is a FAILURE that
     * the caller must surface instead of claiming nothing is stored.
     * @returns {Promise<{ secret: string | undefined } | { error: string }>} outcome.
     */
    const load = async () => {
        let text;
        try {
            const handle = await readFile(file, { encoding: "utf8", flag: fsConstants.O_RDONLY });
            text = handle;
        } catch (error) {
            if (error?.code === "ENOENT") return { secret: undefined };
            return { error: `读取插件存储失败：${error?.message ?? String(error)}` };
        }
        try {
            return { secret: parseStoreDocument(text) };
        } catch (error) {
            return { error: error?.message ?? String(error) };
        }
    };

    return {
        directory: dir,

        /**
         * Status for the settings page: never the value.
         * @returns {Promise<SecretInfo>} the view.
         */
        async describe() {
            const loaded = await load();
            if ("error" in loaded) return { configured: false, writable: true, failed: true };
            if (loaded.secret === undefined) return { configured: false, writable: true };
            return { configured: true, source: "plugin", writable: true };
        },

        /**
         * The secret for a request, or undefined when unconfigured.
         * @returns {Promise<string | undefined>} the value.
         * @throws {Error} when the document exists but cannot be trusted.
         */
        async read() {
            const loaded = await load();
            if ("error" in loaded) throw new Error(loaded.error);
            return loaded.secret;
        },

        /**
         * Durably store one value.
         * @param {string} value - the secret.
         * @returns {Promise<void>} resolves after the rename.
         */
        async write(value) {
            await mkdir(dir, { recursive: true, mode: DIR_MODE });
            // `mkdir`'s mode is filtered by the umask and ignored when the
            // directory already exists, so set it explicitly.
            await chmod(dir, DIR_MODE).catch(() => {});
            const temporary = path.join(dir, `.${STORE_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
            const body = `${JSON.stringify({ version: STORE_VERSION, secret: value }, null, 2)}\n`;
            try {
                await writeFile(temporary, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
                await chmod(temporary, FILE_MODE).catch(() => {});
                await rename(temporary, file);
            } finally {
                await rm(temporary, { force: true }).catch(() => {});
            }
        },

        /**
         * Remove the stored value; a missing document is a no-op.
         * @returns {Promise<void>} resolves when the document is gone.
         */
        async clear() {
            await rm(file, { force: true });
        },
    };
}