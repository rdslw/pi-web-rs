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

function jinaJson(data) {
	return new Response(JSON.stringify({ code: 200, status: 20000, data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

test("reads the Jina JSON envelope and takes the title from the field", async () => {
	const fetchImpl = stubFetch(async () => jinaJson({
		title: "Structured Title",
		url: "https://spa.example.com/",
		content: "The JSON envelope carries the article body as a field. ".repeat(6),
	}));

	const result = await fetchOne("https://spa.example.com/", { engine: "jina", config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(fetchImpl.calls[0].init.headers.Accept, "application/json");
	assert.equal(result.error, null);
	assert.equal(result.title, "Structured Title", "no regex over an envelope");
	assert.match(result.content, /carries the article body/);
});

test("reports the Jina warning, because a failed target still answers 200", async () => {
	// Jina returns HTTP 200 with content "Unknown." for a 404 target. Without
	// the warning the model is told only that the content was unusable.
	const fetchImpl = stubFetch(async () => jinaJson({
		title: "",
		url: "https://gone.example.com/",
		content: "Unknown.",
		warning: "Target URL returned error 404: Not Found",
	}));

	const result = await fetchOne("https://gone.example.com/", { engine: "jina", config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.match(result.error ?? "", /Target URL returned error 404/);
});

test("falls back to the text envelope when JSON is refused or ignored", async () => {
	// A server that ignores the Accept header answers 200 with the text envelope.
	const ignored = stubFetch(async () => textResponse(READER_BODY, "text/plain"));
	const first = await fetchOne("https://spa.example.com/", { engine: "jina", config: testConfig(), lookup: publicLookup, fetchImpl: ignored });
	assert.equal(ignored.calls.length, 1, "a readable body needs no second request");
	assert.equal(first.title, "Rendered Page");

	// A strict server refuses the JSON type outright.
	const refused = stubFetch(async (_url, init) => init.headers.Accept === "application/json"
		? new Response("not acceptable", { status: 406 })
		: textResponse(READER_BODY, "text/plain"));
	const second = await fetchOne("https://spa.example.com/", { engine: "jina", config: testConfig(), lookup: publicLookup, fetchImpl: refused });

	assert.equal(refused.calls.length, 2);
	assert.equal(refused.calls[1].init.headers.Accept, "text/plain");
	assert.equal(second.error, null);
	assert.equal(second.title, "Rendered Page");
});

test("asks Jina to drop images, and bypasses its cache only on request", async () => {
	const fetchImpl = stubFetch(async () => textResponse(READER_BODY, "text/plain"));
	await fetchOne("https://spa.example.com/", { engine: "jina", config: testConfig(), lookup: publicLookup, fetchImpl });

	// Image markdown costs tokens and helps no reader.
	assert.equal(fetchImpl.calls[0].init.headers["X-Retain-Images"], "none");
	// A new render costs latency and rate limit, so the default uses the cache.
	assert.equal(fetchImpl.calls[0].init.headers["X-No-Cache"], undefined);

	const noCache = stubFetch(async () => textResponse(READER_BODY, "text/plain"));
	await fetchOne("https://spa.example.com/", {
		engine: "jina",
		config: testConfig({ jinaNoCache: true }),
		lookup: publicLookup,
		fetchImpl: noCache,
	});
	assert.equal(noCache.calls[0].init.headers["X-No-Cache"], "true");
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

test("the SSRF guard also covers the URL handed to Jina", async () => {
	// r.jina.ai receives the target inside its own path, so the guard must run
	// before the request. The direct engine is covered in extract.test.mjs.
	const fetchImpl = stubFetch(async () => textResponse(READER_BODY, "text/plain"));
	const result = await fetchOne("http://169.254.169.254/latest/meta-data/", {
		engine: "jina",
		config: testConfig(),
		fetchImpl,
	});

	assert.match(result.error ?? "", /Blocked internal address/);
	assert.equal(fetchImpl.calls.length, 0, "the reader service must never see the URL");
});
