import assert from "node:assert/strict";
import { test } from "node:test";

import { extractViaHttp, isPDF, isTerminalError } from "../extract.ts";
import { htmlPage, publicLookup, stubFetch, testConfig, textResponse } from "./helpers.mjs";

const LONG_PARAGRAPH = "Readability keeps the article body and Turndown converts it to markdown for the model.";

test("converts an HTML article to markdown", async () => {
	const fetchImpl = stubFetch(async () => textResponse(htmlPage("Extraction Guide", LONG_PARAGRAPH), "text/html; charset=utf-8"));
	const result = await extractViaHttp("https://example.com/guide", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.error, null);
	assert.equal(result.engine, "http");
	assert.match(result.title, /Extraction Guide/);
	assert.match(result.content, /Turndown converts it to markdown/);
	assert.doesNotMatch(result.content, /<p>/, "HTML tags must not survive the conversion");
});

test("returns plain text and JSON unchanged", async () => {
	const fetchImpl = stubFetch(async () => textResponse('{"status":"ok"}', "application/json"));
	const result = await extractViaHttp("https://api.example.com/status.json", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.error, null);
	assert.equal(result.content, '{"status":"ok"}');
});

test("reports a JavaScript-rendered page as a recoverable error", async () => {
	const shell = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div>${"<script>window.x=1</script>".repeat(6)}</body></html>`;
	const fetchImpl = stubFetch(async () => textResponse(shell, "text/html"));
	const result = await extractViaHttp("https://spa.example.com/", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /JavaScript-rendered|Could not extract/);
	assert.equal(isTerminalError(result.error), false, "the chain must be allowed to try the next engine");
});

test("refuses binary content types", async () => {
	const fetchImpl = stubFetch(async () => textResponse("binary", "application/octet-stream"));
	const result = await extractViaHttp("https://example.com/file.bin", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /Unsupported content type/);
	assert.equal(isTerminalError(result.error), true);
});

test("refuses a body larger than maxResponseBytes", async () => {
	const fetchImpl = stubFetch(async () => textResponse("x".repeat(100), "text/plain", 200, { "content-length": "999999999" }));
	const result = await extractViaHttp("https://example.com/big", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /Response too large/);
	assert.equal(isTerminalError(result.error), true);
});

test("enforces the streamed size limit when no content-length is sent", async () => {
	const fetchImpl = stubFetch(async () => textResponse("x".repeat(5_000), "text/plain"));
	const result = await extractViaHttp("https://example.com/stream", {
		config: testConfig({ maxResponseBytes: 1_000 }),
		lookup: publicLookup,
		fetchImpl,
	});

	assert.match(result.error ?? "", /Response too large/);
});

test("reports an HTTP error status", async () => {
	const fetchImpl = stubFetch(async () => new Response("denied", { status: 403, statusText: "Forbidden" }));
	const result = await extractViaHttp("https://blocked.example.com/", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.status, 403);
	assert.match(result.error ?? "", /HTTP 403/);
	assert.equal(isTerminalError(result.error), false);
});

test("honours pdf.enabled", async () => {
	const fetchImpl = stubFetch(async () => textResponse("%PDF-1.4", "application/pdf"));
	const result = await extractViaHttp("https://example.com/paper.pdf", {
		config: testConfig({ pdf: { enabled: false } }),
		lookup: publicLookup,
		fetchImpl,
	});

	assert.match(result.error ?? "", /PDF extraction is disabled/);
	assert.equal(isTerminalError(result.error), true);
});

test("detects PDFs by extension and by content type", () => {
	assert.equal(isPDF("https://example.com/paper.pdf"), true);
	assert.equal(isPDF("https://example.com/download", "application/pdf; charset=binary"), true);
	assert.equal(isPDF("https://example.com/page.html", "text/html"), false);
});

test("the SSRF guard applies to every fetched URL", async () => {
	const fetchImpl = stubFetch(async () => textResponse("internal", "text/plain"));
	const result = await extractViaHttp("http://169.254.169.254/latest/meta-data/", { config: testConfig(), fetchImpl });

	assert.match(result.error ?? "", /Blocked internal address/);
	assert.equal(fetchImpl.calls.length, 0);
});
