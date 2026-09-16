/**
 * Brave Search API provider.
 *
 * includeContent prefers Brave's own extra_snippets (up to five excerpts per
 * result, Pro plans). When the plan rejects them the caller falls back to
 * fetching the result pages through the fetch chain.
 */

import { loadConfig, type ResolvedConfig } from "./config.ts";
import { errorMessage, isAbortError, readTextWithLimit } from "./extract.ts";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

/** A Brave answer is a few hundred kB. The transport is the same one that serves pages, so it gets the same kind of cap. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** Brave extra_snippets, present only on plans that support them. */
	extraSnippets?: string[];
	/** Publication date as YYYY-MM-DD, from Brave page_age. */
	published?: string;
	/** Brave age, a relative string such as "3 days ago". Fallback for published. */
	age?: string;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
	/** True when the response carried extra snippets. */
	hasExtraSnippets: boolean;
	/** domainFilter entries that are not valid hostnames and were not applied. */
	droppedDomainFilters: string[];
	/** The filters that did reach the query, so the output can name them. */
	appliedDomainFilters: { allowed: string[]; blocked: string[] };
	/** The recency filter that Brave accepted, if any. */
	recencyFilter?: string;
}

export interface BraveSearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	/** Ask for extra_snippets. Ignored when search.extraSnippets is "off". */
	wantExtraSnippets?: boolean;
	signal?: AbortSignal;
	config?: ResolvedConfig;
	fetchImpl?: typeof fetch;
	/** Test seam. Replaces the wait between retries. */
	sleep?: (ms: number) => Promise<void>;
}

/** Failures that a second attempt can repair: the fault is at the API, not in the request. */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/** Retry-After is either a count of seconds or an HTTP date. */
function parseRetryAfter(value: string | null, now = Date.now()): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - now);
}

/** 500 ms, then 1 000 ms, and so on. No jitter: one client, and tests stay readable. */
function backoffDelay(attempt: number): number {
	return 500 * 2 ** attempt;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const FRESHNESS: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

/**
 * Per-process memory of the plan capability. The first rejection of
 * extra_snippets disables the parameter for the rest of the session.
 */
let extraSnippetsRejected = false;

export function resetExtraSnippetSupport(): void {
	extraSnippetsRejected = false;
}

export function extraSnippetsDisabled(): boolean {
	return extraSnippetsRejected;
}

export function isBraveAvailable(config: ResolvedConfig = loadConfig()): boolean {
	return Boolean(config.braveApiKey);
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		input = (input.includes("://") ? new URL(input) : new URL(`https://${input}`)).hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

interface DomainFilters {
	allowed: string[];
	blocked: string[];
	/** Entries that are not valid hostnames. They reach no operator and no local filter. */
	dropped: string[];
}

function normalizeDomainFilters(domainFilter: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { allowed: [], blocked: [], dropped: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		// A dropped entry must be reported: a silent drop tells the model that a
		// filter is active when the results are in fact unfiltered.
		if (!domain) {
			const trimmed = raw.trim();
			if (trimmed && !filters.dropped.includes(trimmed)) filters.dropped.push(trimmed);
			continue;
		}
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

/** Brave has no domain parameter, so filters become search operators. */
function buildQuery(query: string, filters: DomainFilters): string {
	const parts = [query];
	if (filters.allowed.length === 1) parts.push(`site:${filters.allowed[0]}`);
	else if (filters.allowed.length > 1) parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	for (const domain of filters.blocked) parts.push(`NOT site:${domain}`);
	return parts.join(" ");
}

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesFilters(url: string, filters: DomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatches(hostname, domain))) return false;
	return !filters.blocked.some(domain => hostMatches(hostname, domain));
}

function redact(text: string, apiKey: string): string {
	return apiKey ? text.split(apiKey).join("***") : text;
}

/**
 * A transient status is reported with its Retry-After, so the model can decide
 * to wait and ask again instead of treating the search as impossible.
 */
function apiError(response: Response, body: string): string {
	const retryAfter = isTransientStatus(response.status) ? parseRetryAfter(response.headers.get("retry-after")) : null;
	const hint = retryAfter === null ? "" : ` Retry after ${Math.ceil(retryAfter / 1000)} s.`;
	const label = isTransientStatus(response.status) ? " (temporary)" : "";
	return `Brave Search API error ${response.status}${label}: ${body.slice(0, 300)}${hint}`;
}

/** Read an error body under a cap, redacted. An oversized error body is not worth a failure of its own. */
async function readErrorBody(response: Response, apiKey: string): Promise<string> {
	try {
		return redact(await readTextWithLimit(response, MAX_ERROR_BODY_BYTES), apiKey);
	} catch {
		return "(error body too large to read)";
	}
}

/** A plan that does not include extra_snippets answers 422, or 403 with a plan message. */
function isExtraSnippetRejection(status: number, body: string): boolean {
	if (status === 422) return true;
	if (status !== 403) return false;
	const lower = body.toLowerCase();
	return lower.includes("extra_snippets") || lower.includes("plan") || lower.includes("subscription");
}

interface BraveWebResult {
	title?: string;
	url?: string;
	description?: string;
	extra_snippets?: unknown;
	page_age?: string;
	age?: string;
}

/**
 * Brave age is relative to the time of the search ("3 days ago"), so it cannot
 * be compared against another result or against a date in the conversation.
 * page_age is ISO 8601 and is preferred when it is present.
 */
function toPublishedDate(pageAge: string | undefined): string | undefined {
	if (!pageAge) return undefined;
	const parsed = new Date(pageAge);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function toStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return entries.length > 0 ? entries : undefined;
}

export async function searchWithBrave(query: string, options: BraveSearchOptions = {}): Promise<SearchResponse> {
	const config = options.config ?? loadConfig();
	const apiKey = config.braveApiKey;
	if (!apiKey) {
		throw new Error(
			"Brave Search API key not found. Either:\n" +
			'  1. Put { "braveApiKey": "your-key" } in web-rs.json (see /webrs init)\n' +
			"  2. Set BRAVE_API_KEY or PI_WEB_RS_BRAVE_API_KEY\n" +
			"Get a key at https://brave.com/search/api/",
		);
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const numResults = Math.max(1, Math.min(options.numResults ?? config.search.numResults, 20));
	const filters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildQuery(query, filters);

	const mode = config.search.extraSnippets;
	const askExtraSnippets = Boolean(options.wantExtraSnippets) &&
		mode !== "off" &&
		!(mode === "auto" && extraSnippetsRejected);

	const run = async (withExtraSnippets: boolean): Promise<Response> => {
		const params = new URLSearchParams({
			q: searchQuery,
			// Domain operators cost results, so over-fetch and filter locally.
			count: String(filters.allowed.length || filters.blocked.length ? 20 : numResults),
			// Only web results are parsed. Without this Brave builds and sends
			// news, video, and discussion blocks that are thrown away.
			result_filter: "web",
			text_decorations: "0",
			safesearch: config.search.safesearch,
		});
		if (withExtraSnippets) params.set("extra_snippets", "true");
		if (options.recencyFilter && FRESHNESS[options.recencyFilter]) params.set("freshness", FRESHNESS[options.recencyFilter]);
		if (config.search.country) params.set("country", config.search.country);
		if (config.search.searchLang) params.set("search_lang", config.search.searchLang);

		return fetchImpl(`${BRAVE_SEARCH_URL}?${params.toString()}`, {
			method: "GET",
			headers: {
				"X-Subscription-Token": apiKey,
				"Accept": "application/json",
				"Accept-Encoding": "gzip",
			},
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(config.search.timeoutMs), options.signal])
				: AbortSignal.timeout(config.search.timeoutMs),
		});
	};

	const sleep = options.sleep ?? defaultSleep;
	// Budget for the whole wait. A Retry-After longer than one search budget is
	// reported to the caller instead of blocking the agent for a minute.
	let waitLeft = config.search.timeoutMs;

	/**
	 * Run one request, and try again after a transient failure. A retry is not
	 * started when the wait would break the budget: the status is returned and
	 * the normal error path reports it, Retry-After included.
	 */
	const runWithRetry = async (withExtraSnippets: boolean): Promise<Response> => {
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await run(withExtraSnippets);
			} catch (err) {
				// A network error is transient; an abort is the caller's decision.
				if (attempt >= config.search.maxRetries || isAbortError(err) || options.signal?.aborted) throw err;
				const delay = Math.min(backoffDelay(attempt), waitLeft);
				if (delay <= 0) throw err;
				waitLeft -= delay;
				await sleep(delay);
				continue;
			}

			if (response.ok || !isTransientStatus(response.status) || attempt >= config.search.maxRetries) return response;
			if (options.signal?.aborted) return response;

			const delay = parseRetryAfter(response.headers.get("retry-after")) ?? backoffDelay(attempt);
			if (delay > waitLeft) return response;
			waitLeft -= delay;
			await sleep(delay);
		}
	};

	try {
		let response = await runWithRetry(askExtraSnippets);

		if (!response.ok && askExtraSnippets) {
			const body = await readErrorBody(response, apiKey);
			if (isExtraSnippetRejection(response.status, body)) {
				if (mode === "on") {
					throw new Error(
						`Brave rejected extra_snippets (HTTP ${response.status}). This parameter needs a Pro plan. ` +
						'Set search.extraSnippets to "auto" or "off" in web-rs.json.',
					);
				}
				// "auto": remember the plan limit and retry once without the parameter.
				extraSnippetsRejected = true;
				response = await runWithRetry(false);
			} else {
				throw new Error(apiError(response, body));
			}
		}

		if (!response.ok) {
			const body = await readErrorBody(response, apiKey);
			throw new Error(apiError(response, body));
		}

		const data = JSON.parse(await readTextWithLimit(response, MAX_BODY_BYTES)) as { web?: { results?: BraveWebResult[] } };
		const results: SearchResult[] = [];
		let hasExtraSnippets = false;

		for (const item of data.web?.results ?? []) {
			if (!item.url || !matchesFilters(item.url, filters)) continue;
			const extraSnippets = toStringArray(item.extra_snippets);
			if (extraSnippets) hasExtraSnippets = true;
			const published = toPublishedDate(item.page_age);
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.description || "",
				...(extraSnippets ? { extraSnippets } : {}),
				...(published ? { published } : {}),
				...(item.age ? { age: item.age } : {}),
			});
			if (results.length >= numResults) break;
		}

		return {
			query,
			results,
			hasExtraSnippets,
			droppedDomainFilters: filters.dropped,
			appliedDomainFilters: { allowed: filters.allowed, blocked: filters.blocked },
			...(options.recencyFilter && FRESHNESS[options.recencyFilter] ? { recencyFilter: options.recencyFilter } : {}),
		};
	} catch (err) {
		const message = redact(errorMessage(err), apiKey);
		throw message === errorMessage(err) ? err : new Error(message);
	}
}
