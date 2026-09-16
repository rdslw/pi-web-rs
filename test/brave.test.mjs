import assert from "node:assert/strict";
import { test } from "node:test";

import { isBraveAvailable, resetExtraSnippetSupport, searchWithBrave } from "../brave.ts";
import { stubFetch, testConfig } from "./helpers.mjs";

function braveResponse(results) {
	return new Response(JSON.stringify({ web: { results } }), { status: 200, headers: { "content-type": "application/json" } });
}

const RESULTS = [
	{ title: "First", url: "https://docs.example.com/a", description: "First snippet", age: "2 days ago" },
	{ title: "Second", url: "https://blog.example.org/b", description: "Second snippet" },
];

test("maps results and reports availability", async () => {
	const fetchImpl = stubFetch(async () => braveResponse(RESULTS));
	const response = await searchWithBrave("pi agent extensions", { config: testConfig(), fetchImpl });

	assert.equal(isBraveAvailable(testConfig()), true);
	assert.equal(isBraveAvailable(testConfig({ braveApiKey: null })), false);
	assert.equal(response.results.length, 2);
	assert.deepEqual(response.results[0], { title: "First", url: "https://docs.example.com/a", snippet: "First snippet", age: "2 days ago" });
	assert.equal(response.hasExtraSnippets, false);

	const sent = new URL(fetchImpl.calls[0].url);
	assert.equal(sent.searchParams.get("q"), "pi agent extensions");
	assert.equal(sent.searchParams.get("count"), "5");
	assert.equal(sent.searchParams.has("extra_snippets"), false, "extra_snippets costs a Pro plan; ask only when content is wanted");
	assert.equal(fetchImpl.calls[0].init.headers["X-Subscription-Token"], "test-key");
});

test("caps the result count at numResults", async () => {
	const many = Array.from({ length: 12 }, (_, index) => ({ title: `R${index}`, url: `https://example.com/${index}`, description: "" }));
	const fetchImpl = stubFetch(async () => braveResponse(many));
	const response = await searchWithBrave("q", { numResults: 3, config: testConfig(), fetchImpl });

	assert.equal(response.results.length, 3);
});

test("turns the domain filter into search operators and filters the results", async () => {
	const fetchImpl = stubFetch(async () => braveResponse(RESULTS));
	const response = await searchWithBrave("release notes", {
		domainFilter: ["docs.example.com", "-blog.example.org"],
		config: testConfig(),
		fetchImpl,
	});

	const query = new URL(fetchImpl.calls[0].url).searchParams.get("q");
	assert.equal(query, "release notes site:docs.example.com NOT site:blog.example.org");
	assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("count"), "20", "over-fetch, because operators cost results");
	assert.deepEqual(response.results.map(result => result.url), ["https://docs.example.com/a"]);
});

test("maps the recency filter to Brave freshness codes", async () => {
	const fetchImpl = stubFetch(async () => braveResponse(RESULTS));
	await searchWithBrave("news", { recencyFilter: "week", config: testConfig(), fetchImpl });

	assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("freshness"), "pw");
});

test("returns Brave extra snippets as content", async () => {
	resetExtraSnippetSupport();
	const fetchImpl = stubFetch(async () => braveResponse([
		{ ...RESULTS[0], extra_snippets: ["Excerpt one", "Excerpt two"] },
	]));
	const response = await searchWithBrave("q", { wantExtraSnippets: true, config: testConfig(), fetchImpl });

	assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("extra_snippets"), "true");
	assert.equal(response.hasExtraSnippets, true);
	assert.deepEqual(response.results[0].extraSnippets, ["Excerpt one", "Excerpt two"]);
});

test("retries without extra_snippets when the plan rejects them", async () => {
	resetExtraSnippetSupport();
	const fetchImpl = stubFetch(async (url) => new URL(url).searchParams.has("extra_snippets")
		? new Response("VALIDATION: extra_snippets is not available on this plan", { status: 422 })
		: braveResponse(RESULTS));

	const response = await searchWithBrave("q", { wantExtraSnippets: true, config: testConfig(), fetchImpl });

	assert.equal(fetchImpl.calls.length, 2);
	assert.equal(response.results.length, 2);
	assert.equal(response.hasExtraSnippets, false);

	// The plan limit is remembered: the next search asks for the parameter no more.
	const second = stubFetch(async () => braveResponse(RESULTS));
	await searchWithBrave("q2", { wantExtraSnippets: true, config: testConfig(), fetchImpl: second });
	assert.equal(second.calls.length, 1);
	assert.equal(new URL(second.calls[0].url).searchParams.has("extra_snippets"), false);
	resetExtraSnippetSupport();
});

test("extraSnippets \"on\" reports the plan limit instead of hiding it", async () => {
	resetExtraSnippetSupport();
	const fetchImpl = stubFetch(async () => new Response("not on this plan", { status: 422 }));

	await assert.rejects(
		searchWithBrave("q", { wantExtraSnippets: true, config: testConfig({ search: { extraSnippets: "on" } }), fetchImpl }),
		/needs a Pro plan/,
	);
	resetExtraSnippetSupport();
});

test("extraSnippets \"off\" never asks for the parameter", async () => {
	const fetchImpl = stubFetch(async () => braveResponse(RESULTS));
	await searchWithBrave("q", { wantExtraSnippets: true, config: testConfig({ search: { extraSnippets: "off" } }), fetchImpl });

	assert.equal(new URL(fetchImpl.calls[0].url).searchParams.has("extra_snippets"), false);
});

test("reports other API errors and keeps the key out of the message", async () => {
	const fetchImpl = stubFetch(async () => new Response("bad token test-key rejected", { status: 401 }));

	await assert.rejects(
		searchWithBrave("q", { config: testConfig(), fetchImpl }),
		(err) => {
			assert.match(err.message, /Brave Search API error 401/);
			assert.doesNotMatch(err.message, /test-key/);
			return true;
		},
	);
});

test("explains how to configure a missing key", async () => {
	await assert.rejects(
		searchWithBrave("q", { config: testConfig({ braveApiKey: null }) }),
		/braveApiKey.*BRAVE_API_KEY/s,
	);
});
