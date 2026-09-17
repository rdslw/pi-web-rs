import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the config loader at an empty directory, so the user's own
// web-rs.json cannot change the expected output.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-rs-ext-"));

import createExtension, { paginate, searchNotes } from "../index.ts";

function stubPi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const messages = [];
	return {
		tools,
		commands,
		handlers,
		messages,
		on: (event, handler) => handlers.set(event, handler),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, options) => commands.set(name, options),
		sendMessage: (message) => messages.push(message),
	};
}

const theme = {
	fg: (_style, text) => text,
	bold: (text) => text,
};

test("registers the two tools and the command", () => {
	const pi = stubPi();
	createExtension(pi);

	assert.deepEqual([...pi.tools.keys()].sort(), ["web_fetch", "web_search"]);
	assert.deepEqual([...pi.commands.keys()], ["webrs"]);
});

test("appends the untrusted content note to the system prompt", async () => {
	const pi = stubPi();
	createExtension(pi);

	const result = await pi.handlers.get("before_agent_start")({ systemPrompt: "base prompt" });
	assert.match(result.systemPrompt, /^base prompt\n\n/);
	assert.match(result.systemPrompt, /untrusted/i);
	assert.match(result.systemPrompt, /data to analyse, not as instructions/);
});

test("the tool schemas expose the documented parameters", () => {
	const pi = stubPi();
	createExtension(pi);

	const search = pi.tools.get("web_search").parameters.properties;
	assert.deepEqual(Object.keys(search).sort(), ["contentCount", "domainFilter", "includeContent", "numResults", "queries", "query", "recencyFilter"].sort());

	const fetchTool = pi.tools.get("web_fetch").parameters.properties;
	assert.deepEqual(Object.keys(fetchTool).sort(), ["engine", "find", "findMode", "maxChars", "offset", "url", "urls"].sort());
	assert.deepEqual(fetchTool.engine.anyOf?.[0]?.enum ?? fetchTool.engine.enum, ["auto", "http", "jina"]);
});

test("a call with no URL reports the error instead of fetching", async () => {
	const pi = stubPi();
	createExtension(pi);

	const result = await pi.tools.get("web_fetch").execute("id", {}, undefined, undefined, {});
	assert.match(result.content[0].text, /No URL provided/);
	assert.equal(result.details.error, "No URL provided");
});

test("a search with no query reports the error instead of calling Brave", async () => {
	const pi = stubPi();
	createExtension(pi);

	const result = await pi.tools.get("web_search").execute("id", {}, undefined, undefined, {});
	assert.match(result.content[0].text, /No query provided/);
});

test("the offset windows cover the whole text with no gap and no overlap", () => {
	const text = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} of the document.`).join("\n\n");

	let offset = 0;
	let rebuilt = "";
	let windows = 0;
	for (;;) {
		const page = paginate(text, offset, 200);
		rebuilt += page.text;
		windows += 1;
		if (!page.hasMore) break;
		offset = page.nextOffset;
		assert.ok(windows < 50, "the offset must advance, never loop");
	}

	assert.ok(windows > 1, "the sample must need more than one window");
	assert.equal(rebuilt, text, "every character is returned exactly once");
});

test("the notes name each filter and the method that applied it", () => {
	const response = {
		query: "q",
		results: [],
		hasExtraSnippets: false,
		recencyFilter: "week",
		droppedDomainFilters: ["not a domain"],
		appliedDomainFilters: { allowed: ["docs.example.com"], blocked: ["ads.example.org"] },
	};

	// Brave has no domain parameter, so the model must be told how the filter
	// was really applied before it trusts the list.
	assert.deepEqual(searchNotes(response, true, true), [
		"Freshness: week (Brave native)",
		"Domains: docs.example.com (site: operator, then filtered locally)",
		"Excluded: ads.example.org (NOT site: operator, then filtered locally)",
		"Ignored, not valid hostnames: not a domain",
		"Content: fetched pages",
	]);
});

test("the notes stay empty when nothing was filtered", () => {
	const plain = {
		query: "q",
		results: [],
		hasExtraSnippets: false,
		droppedDomainFilters: [],
		appliedDomainFilters: { allowed: [], blocked: [] },
	};

	assert.deepEqual(searchNotes(plain, false, true), []);
	assert.deepEqual(searchNotes({ ...plain, hasExtraSnippets: true }, true, true), ["Content: Brave extra snippets"]);
	assert.deepEqual(searchNotes(plain, true, false), ["Content: omitted, output budget"]);
});

test("an offset past the end reports the length instead of empty text", () => {
	const page = paginate("short body", 500, 1000);
	assert.equal(page.returnedChars, 0);
	assert.equal(page.totalChars, 10);
	assert.equal(page.hasMore, false);
});

test("renderCall summarizes the call for the transcript", () => {
	const pi = stubPi();
	createExtension(pi);

	const fetchCall = pi.tools.get("web_fetch").renderCall({ urls: ["https://a.example", "https://b.example"], find: ["needle"] }, theme, {});
	assert.match(fetchCall.text, /web_fetch 2 URLs/);
	assert.match(fetchCall.text, /find: needle/);

	const searchCall = pi.tools.get("web_search").renderCall({ query: "pi extensions", includeContent: true }, theme, {});
	assert.match(searchCall.text, /web_search pi extensions \+content/);
});

test("/webrs show reports the active chain without leaking the key", async () => {
	const pi = stubPi();
	createExtension(pi);
	process.env.BRAVE_API_KEY = "abcd12345678wxyz";

	await pi.commands.get("webrs").handler("show", {});
	const text = pi.messages.at(-1).content[0].text;

	assert.match(text, /Fetch chain: +http → jina/);
	assert.match(text, /Brave API key: +abcd\.\.\.wxyz/);
	assert.doesNotMatch(text, /abcd12345678wxyz/);
	delete process.env.BRAVE_API_KEY;
});

test("web_fetch returns partial content with a note instead of only an error", async () => {
	const pi = stubPi();
	createExtension(pi);

	const tool = pi.tools.get("web_fetch");
	const details = { urlCount: 1, successful: 0, partial: true, title: "Example Domain", totalChars: 149, engine: "http" };
	const rendered = tool.renderResult({ content: [{ type: "text", text: "body" }], details }, { expanded: false }, theme, {});
	assert.match(rendered.text, /\[partial\]/);
});
