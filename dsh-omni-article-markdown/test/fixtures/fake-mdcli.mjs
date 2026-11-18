#!/usr/bin/env node
/**
 * Stand-in for mdcli used by the plugin tests. Behavior is driven by
 * environment variables so a test can script one call at a time:
 *
 *   FAKE_MDCLI_VERSION    version reported by --version (default 0.2.4)
 *   FAKE_MDCLI_LOG        file that receives one JSON argv line per call
 *   FAKE_MDCLI_MODE       ok | error | timeout | empty | save | browser
 *   FAKE_MDCLI_SLEEP_MS   delay before acting (timeout tests)
 *   FAKE_MDCLI_SAVELESS   when set, a save reports success without a path
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_MDCLI_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);

const version = process.env.FAKE_MDCLI_VERSION ?? "0.2.4";
const mode = process.env.FAKE_MDCLI_MODE ?? "ok";
const sleepMs = Number(process.env.FAKE_MDCLI_SLEEP_MS ?? "0");

if (argv.includes("--version")) {
    process.stdout.write(`mdcli, version ${version}\n`);
    process.exit(0);
}

const wait = () => new Promise((resolve) => setTimeout(resolve, sleepMs));

await wait();

const saveIndex = argv.findIndex((a) => a === "-s" || a === "--save");
const target = argv[1] ?? "";

switch (mode) {
    case "error":
        process.stderr.write("Error: Failed to extract article content.\n");
        process.exit(1);
        break;
    case "browser":
        process.stderr.write("Error: Executable doesn't exist at chromium-1200. Run playwright install.\n");
        process.exit(1);
        break;
    case "empty":
        process.exit(0);
        break;
    case "save": {
        const dir = saveIndex >= 0 ? argv[saveIndex + 1] : "./";
        process.stderr.write("Rendering page > running\n");
        if (!process.env.FAKE_MDCLI_SAVELESS) {
            process.stderr.write(`Article saved to: ${dir.replace(/\/$/u, "")}/article-file.md\n`);
        }
        process.exit(0);
        break;
    }
    default: {
        const truncated = argv.includes("--truncate");
        const body = truncated
            ? "# Title\n\nFirst paragraph only.\n\n…[truncated]"
            : "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
        if (saveIndex >= 0) {
            const dir = argv[saveIndex + 1];
            process.stderr.write(`Article saved to: ${dir.replace(/\/$/u, "")}/Title.md\n`);
        } else {
            process.stdout.write(`${body}\n`);
        }
        process.exit(0);
    }
}
