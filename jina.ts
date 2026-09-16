/**
 * Jina Reader engine. r.jina.ai renders the page server side and returns
 * markdown, so it handles JavaScript pages and many bot blocks that defeat the
 * direct HTTP engine. No key is needed; a key raises the rate limit.
 */

import { loadConfig, type ResolvedConfig } from "./config.ts";
import { abortedResult, errorMessage, extractHeadingTitle, isAbortError, type ExtractedContent, type ExtractOptions } from "./extract.ts";
import { validateRemoteUrl } from "./ssrf.ts";

const JINA_READER_BASE = "https://r.jina.ai/";
const ENVELOPE_MARKER = "Markdown Content:";

function buildHeaders(config: ResolvedConfig): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept": "text/plain",
		"X-Return-Format": "markdown",
		// A reader needs no image markdown, and every image line costs tokens.
		"X-Retain-Images": "none",
	};
	// A new render costs latency and rate limit, so the cached page is used
	// unless the caller asks for a fresh one.
	if (config.jinaNoCache) headers["X-No-Cache"] = "true";
	if (config.jinaApiKey) headers.Authorization = `Bearer ${config.jinaApiKey}`;
	return headers;
}

/** Strip the "Title: / URL Source: / Markdown Content:" envelope when present. */
function parseReaderBody(body: string): { title: string | null; content: string } {
	const marker = body.indexOf(ENVELOPE_MARKER);
	if (marker < 0) return { title: null, content: body.trim() };

	const head = body.slice(0, marker);
	const titleMatch = head.match(/^Title:\s*(.+)$/m);
	return {
		title: titleMatch?.[1].trim() || null,
		content: body.slice(marker + ENVELOPE_MARKER.length).trim(),
	};
}

export async function extractViaJina(url: string, options: ExtractOptions = {}): Promise<ExtractedContent> {
	const config = options.config ?? loadConfig();

	try {
		// Validate the target before it is handed to a third party. This blocks
		// internal hostnames and enforces the domain policy for both engines.
		await validateRemoteUrl(url, {
			allowRanges: config.ssrf.allowRanges,
			domainPolicy: config.domainPolicy,
			...(options.lookup ? { lookup: options.lookup } : {}),
		});

		const signal = options.signal
			? AbortSignal.any([AbortSignal.timeout(config.timeoutMs), options.signal])
			: AbortSignal.timeout(config.timeoutMs);
		const response = await (options.fetchImpl ?? fetch)(JINA_READER_BASE + url, { headers: buildHeaders(config), signal });

		if (!response.ok) {
			const detail = response.status === 429
				? " (rate limited; set jinaApiKey in web-rs.json for a higher limit)"
				: "";
			return { url, title: "", content: "", error: `Jina Reader error ${response.status}${detail}`, status: response.status, engine: "jina" };
		}

		const body = await response.text();
		const { title, content } = parseReaderBody(body);

		if (content.length < config.minUsefulChars ||
			content.startsWith("Loading...") ||
			content.startsWith("Please enable JavaScript")) {
			return { url, title: title ?? "", content, error: "Jina Reader returned no usable content", status: response.status, engine: "jina" };
		}

		const resolvedTitle = title
			?? extractHeadingTitle(content)
			?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title: resolvedTitle, content, error: null, status: response.status, engine: "jina" };
	} catch (err) {
		if (isAbortError(err) || options.signal?.aborted) return abortedResult(url);
		return { url, title: "", content: "", error: errorMessage(err), engine: "jina" };
	}
}
