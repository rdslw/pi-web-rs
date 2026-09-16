import assert from "node:assert/strict";
import { test } from "node:test";

import { extractPDFToMarkdown, extractViaHttp } from "../extract.ts";
import { publicLookup, stubFetch, testConfig } from "./helpers.mjs";

/** Minimal one-page PDF with a single text run. */
function tinyPdf(text = "Hello PDF World") {
	const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
	return new TextEncoder().encode([
		"%PDF-1.4",
		"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
		`4 0 obj<</Length ${content.length}>>stream`,
		content,
		"endstream endobj",
		"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
		"trailer<</Root 1 0 R/Size 6>>",
		"%%EOF",
	].join("\n")).buffer;
}

test("extracts PDF text with unpdf", async () => {
	const result = await extractPDFToMarkdown(tinyPdf(), "https://example.com/paper.pdf", 10);

	assert.equal(result.pages.total, 1);
	assert.equal(result.pages.read, 1);
	assert.match(result.markdown, /Hello PDF World/);
	assert.match(result.markdown, /Source: https:\/\/example\.com\/paper\.pdf/);
});

test("fetches a PDF URL through the HTTP engine", async () => {
	const fetchImpl = stubFetch(async () => new Response(tinyPdf("Fetched PDF body"), {
		status: 200,
		headers: { "content-type": "application/pdf" },
	}));
	const result = await extractViaHttp("https://example.com/paper.pdf", { config: testConfig(), lookup: publicLookup, fetchImpl });

	assert.equal(result.error, null);
	assert.equal(result.mimeType, "application/pdf");
	assert.deepEqual(result.pages, { read: 1, total: 1 });
	assert.match(result.content, /Fetched PDF body/);
});

test("caps the pages read", async () => {
	const result = await extractPDFToMarkdown(tinyPdf(), "https://example.com/paper.pdf", 1);
	assert.equal(result.pages.read, 1);
	assert.match(result.markdown, /Pages: 1 of 1/);
});
