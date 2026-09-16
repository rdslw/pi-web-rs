import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheKey, clearPageCache, getCached, pageCacheSize, setCached } from "../cache.ts";
import { fetchOne } from "../fetch.ts";
import { htmlPage, publicLookup, stubFetch, testConfig, textResponse } from "./helpers.mjs";

const CONFIG = { enabled: true, ttlMs: 300_000, capacity: 3, maxChars: 1_000 };

function entry(content) {
	return { url: "https://example.com/", title: "T", content, error: null, engine: "http" };
}

test("an entry expires at the TTL and is not served after it", () => {
	clearPageCache();
	const key = cacheKey("https://example.com/", "auto");
	setCached(key, entry("body"), CONFIG, 1_000);

	assert.equal(getCached(key, CONFIG, 1_000 + CONFIG.ttlMs)?.content, "body");
	assert.equal(getCached(key, CONFIG, 1_001 + CONFIG.ttlMs), undefined);
	assert.equal(pageCacheSize(), 0, "an expired entry is dropped on read");
});

test("the least recently used entry is evicted first", () => {
	clearPageCache();
	for (const name of ["a", "b", "c"]) setCached(cacheKey(name, "auto"), entry(name), CONFIG);

	// Reading "a" makes "b" the least recent, so "b" goes when "d" arrives.
	getCached(cacheKey("a", "auto"), CONFIG);
	setCached(cacheKey("d", "auto"), entry("d"), CONFIG);

	assert.equal(pageCacheSize(), CONFIG.capacity);
	assert.equal(getCached(cacheKey("b", "auto"), CONFIG), undefined);
	assert.equal(getCached(cacheKey("a", "auto"), CONFIG)?.content, "a");
});

test("the engine choice is part of the key", () => {
	clearPageCache();
	setCached(cacheKey("https://example.com/", "http"), entry("direct"), CONFIG);

	assert.equal(getCached(cacheKey("https://example.com/", "jina"), CONFIG), undefined,
		"an explicit engine must not be served the other engine's text");
	assert.equal(getCached(cacheKey("https://example.com/", "http"), CONFIG)?.content, "direct");
});

test("an oversized page is served but not stored", () => {
	clearPageCache();
	setCached(cacheKey("big", "auto"), entry("x".repeat(CONFIG.maxChars + 1)), CONFIG);
	assert.equal(pageCacheSize(), 0);
});

test("a disabled cache neither reads nor writes", () => {
	clearPageCache();
	const off = { ...CONFIG, enabled: false };
	setCached(cacheKey("x", "auto"), entry("body"), off);
	assert.equal(pageCacheSize(), 0);
	assert.equal(getCached(cacheKey("x", "auto"), off), undefined);
});

test("a second fetch of the same URL costs no request", async () => {
	clearPageCache();
	const page = htmlPage("Cached", "The page cache holds the extracted markdown for a short time. ");
	const fetchImpl = stubFetch(async () => textResponse(page, "text/html"));
	const config = testConfig({ cache: { enabled: true } });

	const first = await fetchOne("https://example.com/", { config, lookup: publicLookup, fetchImpl });
	const second = await fetchOne("https://example.com/", { config, lookup: publicLookup, fetchImpl });

	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(second.content, first.content);
	assert.equal(second.fromCache, true);
	assert.equal(first.fromCache, undefined, "the first read is not marked as cached");
	clearPageCache();
});

test("a failed extraction is not cached, so the next call retries", async () => {
	clearPageCache();
	const fetchImpl = stubFetch(async () => new Response("blocked", { status: 403, statusText: "Forbidden" }));
	const config = testConfig({ fetchChain: ["http"], cache: { enabled: true } });

	await fetchOne("https://blocked.example.com/", { config, lookup: publicLookup, fetchImpl });
	await fetchOne("https://blocked.example.com/", { config, lookup: publicLookup, fetchImpl });

	// A block or a rate limit is usually temporary; caching it would hide a recovery.
	assert.equal(fetchImpl.calls.length, 2);
	clearPageCache();
});
