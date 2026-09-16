/**
 * Direct HTTP extraction: HTML through Readability and Turndown, PDF through
 * unpdf, plain text and JSON returned as they are.
 */

import { loadConfig, type ResolvedConfig } from "./config.ts";
import { fetchRemoteUrl } from "./ssrf.ts";

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	/** Engine that produced the content: "http" or "jina". */
	engine?: string;
	mimeType?: string;
	status?: number;
	/** Pages read from a PDF, and the page count of the document. */
	pages?: { read: number; total: number };
	/** True when the content came from the page cache, not from the network. */
	fromCache?: boolean;
}

export interface ExtractOptions {
	signal?: AbortSignal;
	config?: ResolvedConfig;
	/** Test seam forwarded to the SSRF guard. */
	lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
	/** Test seam. Replaces the global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Errors that no other engine can repair. The fetch chain stops on these
 * instead of paying for a second attempt.
 */
const TERMINAL_ERROR_PREFIXES = [
	"Unsupported content type",
	"Response too large",
	"Blocked internal",
	"Blocked hostname",
	"Blocked credentials",
	"Hostname not in domainPolicy",
	"Only HTTP and HTTPS",
	"PDF extraction is disabled",
	"PDF exceeds",
	"Aborted",
];

export function isTerminalError(error: string | null): boolean {
	if (!error) return false;
	return TERMINAL_ERROR_PREFIXES.some(prefix => error.startsWith(prefix));
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

export function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	return match[1].replace(/\*+/g, "").trim() || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.toLowerCase().includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml");
}

/** A page with almost no text but many scripts renders its content in the browser. */
function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const text = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return text.length < 500 && scriptCount > 3;
}

async function readBufferWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) throw sizeLimitError(maxBytes);
		return buffer;
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw sizeLimitError(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

/** Decode a response body, and fail instead of buffering more than maxBytes. */
export async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
	const buffer = await readBufferWithLimit(response, maxBytes);
	const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

function sizeLimitError(maxBytes: number): Error {
	return new Error(`Response too large (limit ${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

let turndownInstance: Promise<import("turndown")> | undefined;

/** Turndown and Readability load on first use, not at extension startup. */
async function getTurndown() {
	turndownInstance ??= (async () => {
		const { default: TurndownService } = await import("turndown");
		return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }) as unknown as import("turndown");
	})();
	return turndownInstance;
}

/** Extract the text of a PDF buffer as markdown with page markers. */
export async function extractPDFToMarkdown(
	buffer: ArrayBuffer,
	url: string,
	maxPages: number,
): Promise<{ title: string; markdown: string; pages: { read: number; total: number } }> {
	const [unpdf, pdfjs] = await Promise.all([import("unpdf"), import("unpdf/pdfjs")]);
	const { VerbosityLevel } = pdfjs as typeof pdfjs & { VerbosityLevel: { ERRORS: number } };
	const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer), { verbosity: VerbosityLevel.ERRORS });

	const metadata = await pdf.getMetadata();
	const info = metadata.info && typeof metadata.info === "object" ? metadata.info as Record<string, unknown> : null;
	const metaTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
	const title = metaTitle || (new URL(url).pathname.split("/").pop() || url);

	const pagesToRead = Math.min(pdf.numPages, maxPages);
	const lines: string[] = [];
	for (let page = 1; page <= pagesToRead; page++) {
		const textContent = await (await pdf.getPage(page)).getTextContent();
		const pageText = textContent.items
			.map((item: unknown) => (item as { str?: string }).str || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (!pageText) continue;
		if (lines.length > 0) lines.push("", `<!-- Page ${page} -->`, "");
		lines.push(pageText);
	}

	const header = [`# ${title}`, "", `Source: ${url}`, `Pages: ${pagesToRead} of ${pdf.numPages}`, ""].join("\n");
	return {
		title,
		markdown: `${header}\n${lines.join("\n")}`,
		pages: { read: pagesToRead, total: pdf.numPages },
	};
}

/** Fetch a URL directly and extract readable content. */
export async function extractViaHttp(url: string, options: ExtractOptions = {}): Promise<ExtractedContent> {
	const config = options.config ?? loadConfig();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetchRemoteUrl(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": config.userAgent,
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
			},
		}, {
			allowRanges: config.ssrf.allowRanges,
			domainPolicy: config.domainPolicy,
			...(options.lookup ? { lookup: options.lookup } : {}),
			...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
		});

		if (!response.ok) {
			return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}`, status: response.status, engine: "http" };
		}

		const contentType = response.headers.get("content-type") || "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(declaredLength) && declaredLength > config.maxResponseBytes) {
			return { url, title: "", content: "", error: sizeLimitError(config.maxResponseBytes).message, status: response.status, engine: "http" };
		}

		if (isPDF(url, contentType)) {
			if (!config.pdf.enabled) {
				return { url, title: "", content: "", error: "PDF extraction is disabled by pdf.enabled", mimeType, status: response.status, engine: "http" };
			}
			const buffer = await readBufferWithLimit(response, config.maxResponseBytes);
			if (options.signal?.aborted) return abortedResult(url);
			try {
				const result = await extractPDFToMarkdown(buffer, url, config.pdf.maxPages);
				return { url, title: result.title, content: result.markdown, error: null, mimeType: "application/pdf", status: response.status, engine: "http", pages: result.pages };
			} catch (err) {
				if (isAbortError(err)) return abortedResult(url);
				return { url, title: "", content: "", error: `PDF extraction failed: ${errorMessage(err)}`, mimeType, status: response.status, engine: "http" };
			}
		}

		if (!isTextContentType(contentType)) {
			return { url, title: "", content: "", error: `Unsupported content type: ${mimeType || "unknown"}`, mimeType, status: response.status, engine: "http" };
		}

		const text = await readTextWithLimit(response, config.maxResponseBytes);
		const isHTML = mimeType === "text/html" || mimeType === "application/xhtml+xml";
		if (!isHTML) {
			return { url, title: extractTextTitle(text, url), content: text, error: null, mimeType, status: response.status, engine: "http" };
		}

		const { parseHTML } = await import("linkedom");
		const { document } = parseHTML(text);
		const documentTitle = document.title?.trim() ?? "";
		const { Readability } = await import("@mozilla/readability");
		const article = new Readability(document as unknown as Document).parse();

		if (!article || typeof article.content !== "string") {
			return {
				url,
				title: documentTitle,
				content: "",
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Could not extract readable content from HTML structure",
				mimeType,
				status: response.status,
				engine: "http",
			};
		}

		const markdown = (await getTurndown()).turndown(article.content).trim();
		if (markdown.length < config.minUsefulChars) {
			return {
				url,
				title: article.title || documentTitle,
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
				mimeType,
				status: response.status,
				engine: "http",
			};
		}

		return { url, title: article.title || documentTitle, content: markdown, error: null, mimeType, status: response.status, engine: "http" };
	} catch (err) {
		if (options.signal?.aborted) return abortedResult(url);
		return { url, title: "", content: "", error: errorMessage(err), engine: "http" };
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
