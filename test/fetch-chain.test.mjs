import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchMany, fetchOne } from "../fetch.ts";
import { htmlPage, publicLookup, stubFetch, testConfig, textResponse } from "./helpers.mjs";

const READER_BODY = [
	"Title: Rendered Page",
	"URL Source: https://spa.example.com/",
	"Markdown Content:",
	"# Rendered Page",
	"",
	"The Jina Reader executed the page scripts and returned the article text as markdown. ".repeat(4),
].join("\n");

function isJina(url) {
	return url.startsWith("https://r.jina.ai/");
}

test("falls back to Jina after the direct fetch is blocked", async () => {
	const fetchImpl = stubFetch(async (url) => isJina(url)
		? textResponse(READER_BODY, "text/plain")
		: new Response("blocked", { status: 403, statusText: "Forbidden" }));

	const result = await fetchOne("https://spa.example.com/", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.error, null);
	assert.equal(result.engine, "jina");
	assert.equal(result.title, "Rendered Page");
	assert.match(result.content, /returned the article text/);
	assert.equal(fetchImpl.calls.length, 2);
});

test("keeps the direct result when it succeeds", async () => {
	const fetchImpl = stubFetch(async () => textResponse(htmlPage("Direct", "The direct HTTP engine produced usable markdown for the model. "), "text/html"));
	const result = await fetchOne("https://example.com/", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.engine, "http");
	assert.equal(fetchImpl.calls.length, 1, "Jina must not run after a success");
});

test("does not retry a terminal error", async () => {
	const fetchImpl = stubFetch(async () => textResponse("binary", "application/octet-stream"));
	const result = await fetchOne("https://example.com/file.bin", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /Unsupported content type/);
	assert.equal(fetchImpl.calls.length, 1);
});

test("engine override skips the configured chain", async () => {
	const fetchImpl = stubFetch(async (url) => isJina(url)
		? textResponse(READER_BODY, "text/plain")
		: textResponse(htmlPage("Direct", "unused"), "text/html"));

	const result = await fetchOne("https://example.com/", { engine: "jina", config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.engine, "jina");
	assert.equal(fetchImpl.calls.length, 1);
	assert.ok(isJina(fetchImpl.calls[0].url));
});

test("the configured chain order decides which engine runs first", async () => {
	const fetchImpl = stubFetch(async (url) => isJina(url)
		? textResponse(READER_BODY, "text/plain")
		: textResponse(htmlPage("Direct", "The direct HTTP engine produced usable markdown for the model. "), "text/html"));

	const result = await fetchOne("https://example.com/", {
		config: testConfig({ fetchChain: ["jina", "http"] }),
		lookup: publicLookup,
		fetchImpl,
	});

	assert.equal(result.engine, "jina");
	assert.equal(fetchImpl.calls.length, 1);
});

test("an HTTP-only chain reports both the failure and the hint", async () => {
	const fetchImpl = stubFetch(async () => new Response("blocked", { status: 403, statusText: "Forbidden" }));
	const result = await fetchOne("https://blocked.example.com/", {
		config: testConfig({ fetchChain: ["http"] }),
		lookup: publicLookup,
		fetchImpl,
	});

	assert.match(result.error ?? "", /HTTP 403/);
	assert.match(result.error ?? "", /add "jina" to fetchChain/);
	assert.equal(fetchImpl.calls.length, 1);
});

test("reports the Jina rate limit with the key hint", async () => {
	const fetchImpl = stubFetch(async (url) => isJina(url)
		? new Response("too many requests", { status: 429 })
		: new Response("blocked", { status: 403, statusText: "Forbidden" }));

	const result = await fetchOne("https://spa.example.com/", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /HTTP 403/);
	assert.match(result.error ?? "", /jina: Jina Reader error 429/);
	assert.match(result.error ?? "", /jinaApiKey/);
});

test("fetches several URLs in one call", async () => {
	const fetchImpl = stubFetch(async (url) => textResponse(
		htmlPage(`Page ${url.slice(-1)}`, "Each page returns its own readable article body for the model. "),
		"text/html",
	));
	const results = await fetchMany(["https://example.com/1", "https://example.com/2"], {
		config: testConfig(),
		lookup: publicLookup,
		fetchImpl,
	});

	assert.equal(results.length, 2);
	assert.deepEqual(results.map(result => result.error), [null, null]);
	assert.match(results[0].title, /Page 1/);
	assert.match(results[1].title, /Page 2/);
});

test("keeps the text of a page that is only short", async () => {
	const shortPage = "<!doctype html><html><head><title>Example Domain</title></head><body><article><h1>Example Domain</h1><p>This domain is for use in documentation examples.</p></article></body></html>";
	const fetchImpl = stubFetch(async (url) => isJina(url)
		? textResponse("Title: Example Domain\nURL Source: https://example.com/\nMarkdown Content:\n# Example Domain\n\nShort.", "text/plain")
		: textResponse(shortPage, "text/html"));

	const result = await fetchOne("https://example.com/", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /incomplete|no usable content/);
	assert.match(result.content, /This domain is for use in documentation examples/,
		"the extracted text must survive, even though every engine reported a failure");
});
