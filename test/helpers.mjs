import { DEFAULTS } from "../config.ts";

const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];

/** Resolver stub: every hostname is public, so tests never touch DNS. */
export const publicLookup = async () => PUBLIC_ADDRESS;

/** A fully resolved config, independent of the user's web-rs.json. */
export function testConfig(overrides = {}) {
	return {
		braveApiKey: "test-key",
		jinaApiKey: null,
		fetchChain: [...DEFAULTS.fetchChain],
		timeoutMs: 5_000,
		maxResponseBytes: DEFAULTS.maxResponseBytes,
		maxInlineChars: DEFAULTS.maxInlineChars,
		minUsefulChars: DEFAULTS.minUsefulChars,
		concurrency: DEFAULTS.concurrency,
		userAgent: DEFAULTS.userAgent,
		...overrides,
		search: { ...DEFAULTS.search, ...(overrides.search ?? {}) },
		pdf: { ...DEFAULTS.pdf, ...(overrides.pdf ?? {}) },
		ssrf: { allowRanges: [], ...(overrides.ssrf ?? {}) },
		domainPolicy: { allow: [], deny: [], ...(overrides.domainPolicy ?? {}) },
	};
}

/** Build a fetch stub from a handler, recording every request URL. */
export function stubFetch(handler) {
	const calls = [];
	const impl = async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		return handler(url, init, calls.length);
	};
	impl.calls = calls;
	return impl;
}

export function htmlPage(title, paragraph, repeat = 12) {
	const body = Array.from({ length: repeat }, () => `<p>${paragraph}</p>`).join("\n");
	return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}</article></body></html>`;
}

export function textResponse(body, contentType, status = 200, extraHeaders = {}) {
	return new Response(body, { status, headers: { "content-type": contentType, ...extraHeaders } });
}
