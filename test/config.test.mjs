import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, configTemplate, parseFetchChain } from "../config.ts";

test("parses a fetch chain from an array or a comma separated string", () => {
	assert.deepEqual(parseFetchChain(["jina", "http"], DEFAULTS.fetchChain), ["jina", "http"]);
	assert.deepEqual(parseFetchChain("jina,http", DEFAULTS.fetchChain), ["jina", "http"]);
	assert.deepEqual(parseFetchChain(" HTTP , jina ", DEFAULTS.fetchChain), ["http", "jina"]);
	assert.deepEqual(parseFetchChain(["http"], DEFAULTS.fetchChain), ["http"]);
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

test("the JSON file overrides the in-source defaults, and the environment overrides the file", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-rs-"));
	writeFileSync(join(dir, "web-rs.json"), JSON.stringify({
		braveApiKey: "file-key",
		fetchChain: ["jina"],
		timeoutMs: 1234,
		search: { numResults: 9 },
	}));

	// getConfigDir caches per process, so the module is imported in a child
	// environment through a fresh import with the env var already set.
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => { delete process.env.PI_CODING_AGENT_DIR; delete process.env.PI_WEB_RS_FETCH_CHAIN; delete process.env.PI_WEB_RS_BRAVE_API_KEY; });

	const { loadConfig } = await import(`../config.ts?case=${Date.now()}`);
	const fromFile = loadConfig();
	assert.equal(fromFile.braveApiKey, "file-key");
	assert.deepEqual(fromFile.fetchChain, ["jina"]);
	assert.equal(fromFile.timeoutMs, 1234);
	assert.equal(fromFile.search.numResults, 9);
	assert.equal(fromFile.maxInlineChars, DEFAULTS.maxInlineChars, "unset keys keep the in-source default");

	process.env.PI_WEB_RS_FETCH_CHAIN = "http";
	process.env.PI_WEB_RS_BRAVE_API_KEY = "env-key";
	const fromEnv = loadConfig();
	assert.deepEqual(fromEnv.fetchChain, ["http"]);
	assert.equal(fromEnv.braveApiKey, "env-key");
});

test("out-of-range numbers fall back to the defaults", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-rs-"));
	writeFileSync(join(dir, "web-rs.json"), JSON.stringify({ timeoutMs: "soon", search: { numResults: 900 } }));
	process.env.PI_CODING_AGENT_DIR = dir;

	const { loadConfig } = await import(`../config.ts?range=${Date.now()}`);
	const config = loadConfig();
	assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
	assert.equal(config.search.numResults, 20, "clamped to the Brave maximum");
	delete process.env.PI_CODING_AGENT_DIR;
});
