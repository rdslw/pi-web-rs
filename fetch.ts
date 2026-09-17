/**
 * Fetch chain. The engine order comes from config.fetchChain (DEFAULTS in
 * config.ts, overridable by web-rs.json); a tool call can override it with
 * engine: "http" or engine: "jina".
 */

import pLimit from "p-limit";
import { cacheKey, getCached, setCached } from "./cache.ts";
import { loadConfig, type FetchEngine, type ResolvedConfig } from "./config.ts";
import { abortedResult, isTerminalError, type ExtractedContent } from "./extract.ts";
import { extractViaHttp } from "./extract.ts";
import { extractViaJina } from "./jina.ts";

export type EngineChoice = "auto" | FetchEngine;

export interface FetchChainOptions {
	engine?: EngineChoice;
	signal?: AbortSignal;
	config?: ResolvedConfig;
	lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
	/** Test seam. Replaces the global fetch in both engines. */
	fetchImpl?: typeof fetch;
}

const ENGINES: Record<FetchEngine, (url: string, options: {
	signal?: AbortSignal;
	config: ResolvedConfig;
	lookup?: FetchChainOptions["lookup"];
	fetchImpl?: typeof fetch;
}) => Promise<ExtractedContent>> = {
	http: (url, options) => extractViaHttp(url, options),
	jina: (url, options) => extractViaJina(url, options),
};

function resolveChain(config: ResolvedConfig, engine: EngineChoice | undefined): FetchEngine[] {
	if (engine && engine !== "auto") return [engine];
	return config.fetchChain.length > 0 ? config.fetchChain : ["http"];
}

/** Run the chain for one URL and return the first usable extraction. */
export async function fetchOne(url: string, options: FetchChainOptions = {}): Promise<ExtractedContent> {
	const config = options.config ?? loadConfig();
	if (options.signal?.aborted) return abortedResult(url);

	// Only a complete extraction is cached. A failure must be retried, because
	// a block or a rate limit is usually temporary.
	const key = cacheKey(url, options.engine);
	const cached = getCached(key, config.cache);
	if (cached) return cached;

	const chain = resolveChain(config, options.engine);
	const attempts: string[] = [];
	let firstResult: ExtractedContent | null = null;
	let bestPartial: ExtractedContent | null = null;

	for (const engine of chain) {
		const result = await ENGINES[engine](url, {
			config,
			...(options.signal ? { signal: options.signal } : {}),
			...(options.lookup ? { lookup: options.lookup } : {}),
			...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		});
		firstResult ??= result;
		if (!result.error) {
			setCached(key, result, config.cache);
			return result;
		}
		if (options.signal?.aborted) return abortedResult(url);

		// A short page is reported as incomplete, but the text is still the page.
		// Keep the longest such extraction instead of returning nothing.
		if (result.content.length > (bestPartial?.content.length ?? 0)) bestPartial = result;

		attempts.push(`${engine}: ${result.error}`);
		if (isTerminalError(result.error)) return result;
	}

	const base = bestPartial ?? firstResult ?? { url, title: "", content: "", error: "No fetch engine configured" };
	const suffix = chain.length > 1 ? `\n\nEngines tried:\n  ${attempts.join("\n  ")}` : "";
	const hint = chain.includes("jina") ? "" : "\n\nHint: add \"jina\" to fetchChain in web-rs.json to retry blocked or JavaScript-rendered pages.";
	return { ...base, error: `${attempts[0] ?? base.error}${suffix}${hint}` };
}

/** Run the chain for several URLs, bounded by config.concurrency. */
export async function fetchMany(urls: string[], options: FetchChainOptions = {}): Promise<ExtractedContent[]> {
	const config = options.config ?? loadConfig();
	const limit = pLimit(config.concurrency);
	return Promise.all(urls.map(url => limit(() => fetchOne(url, { ...options, config }))));
}
