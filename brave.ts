/**
 * Brave Search API provider.
 *
 * includeContent prefers Brave's own extra_snippets (up to five excerpts per
 * result, Pro plans). When the plan rejects them the caller falls back to
 * fetching the result pages through the fetch chain.
 */

import { loadConfig, type ResolvedConfig } from "./config.ts";
import { errorMessage, readTextWithLimit } from "./extract.ts";

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
	age?: string;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
	/** True when the response carried extra snippets. */
	hasExtraSnippets: boolean;
	/** domainFilter entries that are not valid hostnames and were not applied. */
	droppedDomainFilters: string[];
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
}

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
	age?: string;
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
				? AbortSignal.any([AbortSignal.timeout(config.timeoutMs), options.signal])
				: AbortSignal.timeout(config.timeoutMs),
		});
	};

	try {
		let response = await run(askExtraSnippets);

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
				response = await run(false);
			} else {
				throw new Error(`Brave Search API error ${response.status}: ${body.slice(0, 300)}`);
			}
		}

		if (!response.ok) {
			const body = await readErrorBody(response, apiKey);
			throw new Error(`Brave Search API error ${response.status}: ${body.slice(0, 300)}`);
		}

		const data = JSON.parse(await readTextWithLimit(response, MAX_BODY_BYTES)) as { web?: { results?: BraveWebResult[] } };
		const results: SearchResult[] = [];
		let hasExtraSnippets = false;

		for (const item of data.web?.results ?? []) {
			if (!item.url || !matchesFilters(item.url, filters)) continue;
			const extraSnippets = toStringArray(item.extra_snippets);
			if (extraSnippets) hasExtraSnippets = true;
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.description || "",
				...(extraSnippets ? { extraSnippets } : {}),
				...(item.age ? { age: item.age } : {}),
			});
			if (results.length >= numResults) break;
		}

		return { query, results, hasExtraSnippets, droppedDomainFilters: filters.dropped };
	} catch (err) {
		const message = redact(errorMessage(err), apiKey);
		throw message === errorMessage(err) ? err : new Error(message);
	}
}
