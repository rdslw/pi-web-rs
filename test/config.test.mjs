import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, configTemplate, loadConfig, parseFetchChain } from "../config.ts";

test("parses a fetch chain from an array", () => {
	assert.deepEqual(parseFetchChain(["jina", "http"], DEFAULTS.fetchChain), ["jina", "http"]);
	assert.deepEqual(parseFetchChain([" HTTP ", "jina"], DEFAULTS.fetchChain), ["http", "jina"]);
	assert.deepEqual(parseFetchChain(["http"], DEFAULTS.fetchChain), ["http"]);
	assert.deepEqual(parseFetchChain("jina,http", DEFAULTS.fetchChain), DEFAULTS.fetchChain, "a string is not a chain: the file holds an array");
});

test("drops unknown and duplicate engines", () => {
	assert.deepEqual(parseFetchChain(["http", "http", "curl"], DEFAULTS.fetchChain), ["http"]);
	assert.deepEqual(parseFetchChain(["curl", "wget"], DEFAULTS.fetchChain), DEFAULTS.fetchChain);
	assert.deepEqual(parseFetchChain(undefined, DEFAULTS.fetchChain), DEFAULTS.fetchChain);
	assert.deepEqual(parseFetchChain(42, DEFAULTS.fetchChain), DEFAULTS.fetchChain);
});

test("configTemplate includes all defaults and configurable keys", () => {
	const template = configTemplate();
	assert.equal(template.braveApiKey, "");
	assert.equal(template.jinaApiKey, "");
	assert.deepEqual(template.fetchChain, DEFAULTS.fetchChain);
	assert.equal(template.timeoutMs, DEFAULTS.timeoutMs);
	assert.equal(template.maxResponseBytes, DEFAULTS.maxResponseBytes);
	assert.equal(template.maxInlineChars, DEFAULTS.maxInlineChars);
	assert.equal(template.minUsefulChars, DEFAULTS.minUsefulChars);
	assert.equal(template.concurrency, DEFAULTS.concurrency);
	assert.equal(template.userAgent, DEFAULTS.userAgent);
	assert.deepEqual(template.search, DEFAULTS.search);
	assert.deepEqual(template.pdf, DEFAULTS.pdf);
	assert.deepEqual(template.ssrf, { allowRanges: [] });
	assert.deepEqual(template.domainPolicy, { allow: [], deny: [] });
});

/** Every configurable key as a flat "section.key" map, the shape README documents. */
function flatTemplate() {
	const flat = new Map();
	for (const [key, value] of Object.entries(configTemplate())) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			for (const [sub, subValue] of Object.entries(value)) flat.set(`${key}.${sub}`, subValue);
		} else {
			flat.set(key, value);
		}
	}
	return flat;
}

test("README documents every config key with its real default", () => {
	// The options table is the only complete view a user has of the config, so a
	// key added to DEFAULTS and not to README is a silent gap.
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
	const example = readme.slice(readme.indexOf("### Full configuration"), readme.indexOf("### Options reference"));
	const rows = readme.slice(readme.indexOf("### Options reference"));
	const documented = new Map([...rows.matchAll(/^\| `([\w.]+)` \| [^|]+\| ([^|]+)\|/gm)].map(([, key, value]) => [key, value]));

	const template = flatTemplate();
	for (const [key, value] of template) {
		assert.ok(documented.has(key), `${key} is missing from the options reference`);
		assert.ok(example.includes(`"${key.split(".").pop()}"`), `${key} is missing from the full configuration example`);
		// The table states the browser for userAgent, not the whole header.
		if (key === "userAgent") continue;
		const shown = documented.get(key).replaceAll(" ", "");
		assert.ok(shown.includes(JSON.stringify(value).replaceAll(" ", "")), `${key}: README says ${shown}, DEFAULTS says ${JSON.stringify(value)}`);
	}
	assert.deepEqual([...documented.keys()].filter(key => !template.has(key)), [], "the table documents a key the config does not have");
});

test("the JSON file overrides the in-source defaults, and the environment overrides the file", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-rs-"));
	writeFileSync(join(dir, "web-rs.json"), JSON.stringify({
		braveApiKey: "file-key",
		fetchChain: ["jina"],
		timeoutMs: 1234,
		search: { numResults: 9 },
	}));

	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => { delete process.env.PI_CODING_AGENT_DIR; delete process.env.BRAVE_API_KEY; });

	const fromFile = loadConfig();
	assert.equal(fromFile.braveApiKey, "file-key");
	assert.deepEqual(fromFile.fetchChain, ["jina"]);
	assert.equal(fromFile.timeoutMs, 1234);
	assert.equal(fromFile.search.numResults, 9);
	assert.equal(fromFile.maxInlineChars, DEFAULTS.maxInlineChars, "unset keys keep the in-source default");

	// The API keys are the only values an environment variable can set.
	process.env.BRAVE_API_KEY = "env-key";
	const fromEnv = loadConfig();
	assert.equal(fromEnv.braveApiKey, "env-key");
	assert.deepEqual(fromEnv.fetchChain, ["jina"], "every other key comes from the file");
});

test("out-of-range numbers fall back to the defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-rs-"));
	writeFileSync(join(dir, "web-rs.json"), JSON.stringify({ timeoutMs: "soon", search: { numResults: 900 } }));
	process.env.PI_CODING_AGENT_DIR = dir;

	const config = loadConfig();
	assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
	assert.equal(config.search.numResults, 20, "clamped to the Brave maximum");
	delete process.env.PI_CODING_AGENT_DIR;
});
