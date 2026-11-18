import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyFailure, shouldRetry } from "../src/errors.mjs";

test("extraction failures point at raw_html and are not retried", () => {
    const failure = classifyFailure("Failed to extract article content.");
    assert.equal(failure.kind, "extract");
    assert.equal(shouldRetry(failure), false);
    assert.match(failure.message, /raw_html: true/u);
});

test("browser failures name the Chromium install command", () => {
    const failure = classifyFailure("Executable doesn't exist at ~/Library/Caches/ms-playwright/chromium-1200");
    assert.equal(failure.kind, "browser");
    assert.equal(shouldRetry(failure), false);
    assert.match(failure.message, /playwright install chromium/u);
});

test("SSL failures are retried once and suggest no_verify_ssl", () => {
    const failure = classifyFailure("SSLError: certificate verify failed");
    assert.equal(failure.kind, "ssl");
    assert.equal(shouldRetry(failure), true);
    assert.match(failure.message, /no_verify_ssl: true/u);
});

test("network timeouts are retryable", () => {
    const failure = classifyFailure("Connection reset by peer");
    assert.equal(failure.kind, "timeout");
    assert.equal(shouldRetry(failure), true);
    const explicit = classifyFailure("", { kind: "timeout" });
    assert.equal(explicit.kind, "timeout");
    assert.match(explicit.message, /超时/u);
});

test("an unknown --truncate option names the minimum version", () => {
    const failure = classifyFailure("No such option: --truncate");
    assert.equal(failure.kind, "unsupported-option");
    assert.match(failure.message, /0\.2\.4/u);
});

test("other failures keep the message and the issue link", () => {
    const failure = classifyFailure("Weird parser state");
    assert.equal(failure.kind, "other");
    assert.match(failure.message, /Weird parser state/u);
    assert.match(failure.message, /github\.com\/caol64\/omni-article-markdown\/issues/u);
});
