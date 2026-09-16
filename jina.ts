/**
 * Jina Reader engine. r.jina.ai renders the page server side and returns
 * markdown, so it handles JavaScript pages and many bot blocks that defeat the
 * direct HTTP engine. No key is needed; a key raises the rate limit.
 */

import { loadConfig, type ResolvedConfig } from "./config.ts";
import { abortedResult, errorMessage, extractHeadingTitle, isAbortError, readTextWithLimit, type ExtractedContent, type ExtractOptions } from "./extract.ts";
import { validateRemoteUrl } from "./ssrf.ts";

const JINA_READER_BASE = "https://r.jina.ai/";
const ENVELOPE_MARKER = "Markdown Content:";

function buildHeaders(config: ResolvedConfig, accept: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept": accept,
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

interface ReaderBody {
	title: string | null;
	content: string;
	/**
	 * Jina answers 200 even when the target failed, and names the true cause
	 * here, for example "Target URL returned error 404: Not Found".
	 */
	warning?: string;
}

/**
 * JSON envelope: { code, status, data: { title, description, url, content } }.
 * Returns null when the body is not that shape, so the caller can fall back to
 * the text envelope. A server that ignores the Accept header lands there.
 */
function parseJsonBody(body: string): ReaderBody | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}

	const data = (parsed as { data?: unknown })?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;

	const record = data as Record<string, unknown>;
	const content = typeof record.content === "string" ? record.content.trim() : "";
	const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : null;
	const warning = typeof record.warning === "string" && record.warning.trim() ? record.warning.trim() : undefined;
	if (!content && !warning) return null;

	return { title, content, ...(warning ? { warning } : {}) };
}

/** Strip the "Title: / URL Source: / Markdown Content:" envelope when present. */
function parseReaderBody(body: string): ReaderBody {
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
		const fetchImpl = options.fetchImpl ?? fetch;
		const request = (accept: string) =>
			fetchImpl(JINA_READER_BASE + url, { headers: buildHeaders(config, accept), signal });

		// JSON first: it carries the title as a field and, more important, the
		// warning field that names why a target failed. Jina answers 200 for a
		// failed target, so the text mode can only report "no usable content".
		let response = await request("application/json");
		if (response.status === 406 || response.status === 415) response = await request("text/plain");

		if (!response.ok) {
			const detail = response.status === 429
				? " (rate limited; set jinaApiKey in web-rs.json for a higher limit)"
				: "";
			return { url, title: "", content: "", error: `Jina Reader error ${response.status}${detail}`, status: response.status, engine: "jina" };
		}

		const body = await readTextWithLimit(response, config.maxResponseBytes);
		const { title, content, warning } = parseJsonBody(body) ?? parseReaderBody(body);

		if (content.length < config.minUsefulChars ||
			content.startsWith("Loading...") ||
			content.startsWith("Please enable JavaScript")) {
			// The warning names the real fault; without it the cause is unknown.
			const reason = warning ? `Jina Reader: ${warning}` : "Jina Reader returned no usable content";
			return { url, title: title ?? "", content, error: reason, status: response.status, engine: "jina" };
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
