import assert from "node:assert/strict";
import { test } from "node:test";

import { findContent } from "../find.ts";

const PAGE = [
	"# Release notes",
	"",
	"The extension registers two tools. The fetch chain is configurable.",
	"",
	"Rate limits apply to the Brave Search API on the free plan.",
	"",
	"Extraction uses Readability and Turndown.",
].join("\n");

test("exact mode respects case", () => {
	assert.equal(findContent(PAGE, ["Rate limits"], "exact").matchCount, 1);
	assert.equal(findContent(PAGE, ["rate limits"], "exact").matchCount, 0);
});

test("case-insensitive mode ignores case", () => {
	const result = findContent(PAGE, ["RATE LIMITS"], "case-insensitive");
	assert.equal(result.matchCount, 1);
	assert.match(result.text, /Brave Search API/);
});

test("fuzzy mode tolerates a misspelling", () => {
	assert.equal(findContent(PAGE, ["Readabilty Turndown"], "fuzzy").matchCount, 1);
});

test("output names the queries that matched nothing", () => {
	const result = findContent(PAGE, ["Turndown", "websocket"], "case-insensitive");
	assert.equal(result.matchCount, 1);
	assert.match(result.text, /No matches: "websocket"/);
});

test("a match returns its context, not the whole page", () => {
	const filler = "Lorem ipsum dolor sit amet. ".repeat(400);
	const page = `${filler}The needle is here.${filler}`;
	const result = findContent(page, ["needle"], "exact");

	assert.equal(result.matchCount, 1);
	assert.match(result.text, /The needle is here/);
	assert.ok(result.text.length < page.length / 4, "context extract must be far shorter than the page");
});

test("duplicate queries are counted once", () => {
	const result = findContent(PAGE, ["tools", "tools", " tools "], "case-insensitive");
	assert.equal(result.queryResults.length, 1);
});
