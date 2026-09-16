import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRemoteUrl, validateRemoteUrl } from "../ssrf.ts";
import { publicLookup, stubFetch, textResponse } from "./helpers.mjs";

test("blocks loopback, private, link-local, and metadata targets", async () => {
	const blocked = [
		"http://localhost/",
		"http://127.0.0.1/",
		"http://10.0.0.1/",
		"http://172.16.0.1/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://0.0.0.0/",
		"http://[::1]/",
		"http://[fe80::1]/",
		"http://[fd00::1]/",
		"http://[::ffff:127.0.0.1]/",
	];
	for (const url of blocked) {
		await assert.rejects(validateRemoteUrl(url, { lookup: publicLookup }), /Blocked/, `${url} must be blocked`);
	}
});

test("blocks non-HTTP protocols", async () => {
	await assert.rejects(validateRemoteUrl("file:///etc/passwd"), /Only HTTP and HTTPS/);
});

test("accepts a public host", async () => {
	const url = await validateRemoteUrl("https://example.com/page", { lookup: publicLookup });
	assert.equal(url.hostname, "example.com");
});

test("allowRanges exempts a reserved range", async () => {
	await assert.rejects(
		validateRemoteUrl("https://fake.example", { lookup: async () => [{ address: "198.18.0.5", family: 4 }] }),
		/198\.18\.0\.0\/15/,
	);
	const url = await validateRemoteUrl("https://fake.example", {
		lookup: async () => [{ address: "198.18.0.5", family: 4 }],
		allowRanges: ["198.18.0.0/15"],
	});
	assert.equal(url.hostname, "fake.example");
});

test("rejects a malformed allowRanges entry instead of failing open", async () => {
	await assert.rejects(
		validateRemoteUrl("https://example.com", { lookup: publicLookup, allowRanges: ["10.0.0.0/"] }),
		/Invalid CIDR/,
	);
});

test("domain policy denies and allows by suffix", async () => {
	await assert.rejects(
		validateRemoteUrl("https://ads.example.com", { lookup: publicLookup, domainPolicy: { allow: [], deny: ["example.com"] } }),
		/domainPolicy\.deny/,
	);
	await assert.rejects(
		validateRemoteUrl("https://other.test", { lookup: publicLookup, domainPolicy: { allow: ["example.com"], deny: [] } }),
		/domainPolicy\.allow/,
	);
	const url = await validateRemoteUrl("https://docs.example.com", { lookup: publicLookup, domainPolicy: { allow: ["example.com"], deny: [] } });
	assert.equal(url.hostname, "docs.example.com");
});

test("revalidates every redirect hop", async () => {
	const fetchImpl = stubFetch(async (url) => url.includes("start")
		? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
		: textResponse("secret", "text/plain"));

	await assert.rejects(
		fetchRemoteUrl("https://start.example/", {}, { lookup: publicLookup, fetch: fetchImpl }),
		/Blocked internal address/,
	);
	assert.equal(fetchImpl.calls.length, 1, "the redirect target must not be requested");
});

test("stops after the redirect limit", async () => {
	const fetchImpl = stubFetch(async () => new Response(null, { status: 302, headers: { location: "https://loop.example/next" } }));
	await assert.rejects(
		fetchRemoteUrl("https://loop.example/", {}, { lookup: publicLookup, fetch: fetchImpl, maxRedirects: 2 }),
		/Too many redirects/,
	);
});
