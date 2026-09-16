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
	assert.equal(sent.searchParams.get("result_filter"), "web", "only web results are parsed, so ask for no other section");
	assert.equal(sent.searchParams.has("extra_snippets"), false, "extra_snippets costs a Pro plan; ask only when content is wanted");
	assert.equal(fetchImpl.calls[0].init.headers["X-Subscription-Token"], "test-key");
});

test("prefers the absolute page_age date over the relative age string", async () => {
	const fetchImpl = stubFetch(async () => braveResponse([
		{ title: "Dated", url: "https://example.com/a", description: "", page_age: "2026-03-14T09:00:00Z", age: "3 days ago" },
		{ title: "Relative only", url: "https://example.com/b", description: "", age: "3 days ago" },
		{ title: "Unparseable", url: "https://example.com/c", description: "", page_age: "soon" },
	]));
	const response = await searchWithBrave("q", { config: testConfig(), fetchImpl });

	assert.equal(response.results[0].published, "2026-03-14");
	assert.equal(response.results[1].published, undefined, "age stays the fallback when page_age is absent");
	assert.equal(response.results[1].age, "3 days ago");
	assert.equal(response.results[2].published, undefined, "an unparseable date is dropped, not passed on");
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

test("reports domain filter entries that are not valid hostnames", async () => {
	const fetchImpl = stubFetch(async () => braveResponse(RESULTS));
	const response = await searchWithBrave("q", {
		domainFilter: ["docs.example.com", "not a domain", "-"],
		config: testConfig(),
		fetchImpl,
	});

	// A silent drop would tell the model that a filter is active when it is not.
	assert.deepEqual(response.droppedDomainFilters, ["not a domain", "-"]);
	assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("q"), "q site:docs.example.com");
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

test("retries a transient failure and waits the Retry-After", async () => {
	const waits = [];
	const fetchImpl = stubFetch(async (_url, _init, call) => call === 1
		? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
		: braveResponse(RESULTS));

	const response = await searchWithBrave("q", {
		config: testConfig(),
		fetchImpl,
		sleep: async (ms) => { waits.push(ms); },
	});

	assert.equal(fetchImpl.calls.length, 2);
	assert.deepEqual(waits, [2000], "the wait comes from Retry-After, not from the backoff");
	assert.equal(response.results.length, 2);
});

test("falls back to the backoff when Brave sends no Retry-After", async () => {
	const waits = [];
	const fetchImpl = stubFetch(async (_url, _init, call) => call < 3
		? new Response("busy", { status: 503 })
		: braveResponse(RESULTS));

	await searchWithBrave("q", { config: testConfig(), fetchImpl, sleep: async (ms) => { waits.push(ms); } });

	assert.equal(fetchImpl.calls.length, 3, "two retries, the configured maximum");
	assert.deepEqual(waits, [500, 1000]);
});

test("does not retry a permanent failure", async () => {
	const fetchImpl = stubFetch(async () => new Response("bad request", { status: 400 }));

	await assert.rejects(
		searchWithBrave("q", { config: testConfig(), fetchImpl, sleep: async () => {} }),
		/Brave Search API error 400/,
	);
	assert.equal(fetchImpl.calls.length, 1, "a 400 is the request's fault; a second attempt fails the same way");
});

test("reports a Retry-After that is longer than the search budget instead of waiting", async () => {
	const waits = [];
	const fetchImpl = stubFetch(async () => new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));

	await assert.rejects(
		searchWithBrave("q", { config: testConfig(), fetchImpl, sleep: async (ms) => { waits.push(ms); } }),
		(err) => {
			// Blocking the agent for ten minutes is worse than reporting the wait.
			assert.match(err.message, /temporary/);
			assert.match(err.message, /Retry after 600 s/);
			return true;
		},
	);
	assert.equal(fetchImpl.calls.length, 1);
	assert.deepEqual(waits, []);
});

test("maxRetries 0 turns the retry off", async () => {
	const fetchImpl = stubFetch(async () => new Response("busy", { status: 503 }));

	await assert.rejects(
		searchWithBrave("q", { config: testConfig({ search: { maxRetries: 0 } }), fetchImpl, sleep: async () => {} }),
		/503/,
	);
	assert.equal(fetchImpl.calls.length, 1);
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

test("caps the search response body, like any other body", async () => {
	// The search answer arrives over the same transport that serves pages, so
	// an unbounded read here would undo the cap that extract.ts enforces.
	const huge = "x".repeat(2 * 1024 * 1024 + 1024);
	const fetchImpl = stubFetch(async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }));

	await assert.rejects(searchWithBrave("q", { config: testConfig(), fetchImpl }), /Response too large/);
});

test("explains how to configure a missing key", async () => {
	await assert.rejects(
		searchWithBrave("q", { config: testConfig({ braveApiKey: null }) }),
		/braveApiKey.*BRAVE_API_KEY/s,
	);
});
