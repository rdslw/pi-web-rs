import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the config loader at an empty directory, so the user's own
// web-rs.json cannot change the expected output.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-rs-ext-"));

import createExtension from "../index.ts";

function stubPi() {
	const tools = new Map();
	const commands = new Map();
	const messages = [];
	return {
		tools,
		commands,
		messages,
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

test("the tool schemas expose the documented parameters", () => {
	const pi = stubPi();
	createExtension(pi);

	const search = pi.tools.get("web_search").parameters.properties;
	assert.deepEqual(Object.keys(search).sort(), ["contentCount", "domainFilter", "includeContent", "numResults", "queries", "query", "recencyFilter"].sort());

	const fetchTool = pi.tools.get("web_fetch").parameters.properties;
	assert.deepEqual(Object.keys(fetchTool).sort(), ["engine", "find", "findMode", "maxChars", "url", "urls"].sort());
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
	process.env.PI_WEB_RS_BRAVE_API_KEY = "abcd12345678wxyz";

	await pi.commands.get("webrs").handler("show", {});
	const text = pi.messages.at(-1).content[0].text;

	assert.match(text, /Fetch chain: +http → jina/);
	assert.match(text, /Brave API key: +abcd\.\.\.wxyz/);
	assert.doesNotMatch(text, /abcd12345678wxyz/);
	delete process.env.PI_WEB_RS_BRAVE_API_KEY;
});

test("web_fetch returns partial content with a note instead of only an error", async () => {
	const pi = stubPi();
	createExtension(pi);

	const tool = pi.tools.get("web_fetch");
	const details = { urlCount: 1, successful: 0, partial: true, title: "Example Domain", totalChars: 149, engine: "http" };
	const rendered = tool.renderResult({ content: [{ type: "text", text: "body" }], details }, { expanded: false }, theme, {});
	assert.match(rendered.text, /\[partial\]/);
});
