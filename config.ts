/**
 * pi-web-rs configuration.
 *
 * Precedence, highest first:
 *   1. environment variables
 *   2. the JSON file ~/.pi/agent/web-rs.json
 *   3. the DEFAULTS block in this file
 *
 * Edit the DEFAULTS block to change the behaviour of the extension without a
 * JSON file. The fetch chain is the first entry: it sets which extractors
 * web_fetch uses and in which order.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FetchEngine = "http" | "jina";
export type SafeSearch = "off" | "moderate" | "strict";
export type Tristate = "auto" | "on" | "off";

// ───────────────────────────── editable defaults ─────────────────────────────

export const DEFAULTS = {
	/**
	 * Extraction order for web_fetch. The first engine that returns usable
	 * content wins; the next engine runs only after a recoverable failure.
	 *   ["http", "jina"] — direct fetch first, Jina Reader as fallback
	 *   ["jina", "http"] — Jina Reader first, direct fetch as fallback
	 *   ["http"]         — no third party ever sees the target URL
	 *   ["jina"]         — always route through Jina Reader
	 */
	fetchChain: ["http", "jina"] as FetchEngine[],

	/** Budget for one fetch attempt, in milliseconds. */
	timeoutMs: 30_000,
	/** Hard cap on a downloaded body. Larger responses fail. */
	maxResponseBytes: 5 * 1024 * 1024,
	/** Default cap on the characters returned to the model per tool call. */
	maxInlineChars: 30_000,
	/** Below this length an extraction counts as failed and the chain continues. */
	minUsefulChars: 200,
	/** Parallel fetches inside one tool call. */
	concurrency: 3,
	/** User-Agent header for direct HTTP fetches. */
	userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	/**
	 * Append a line to the system prompt that tells the model to treat fetched
	 * web content as data, not as instructions. Turn it off only when every
	 * reachable page is trusted.
	 */
	untrustedContentPrompt: true,

	/**
	 * Send X-No-Cache to Jina Reader, which orders a new render instead of the
	 * cached one. It costs latency and rate limit, so it is off by default.
	 */
	jinaNoCache: false,

	search: {
		/**
		 * Budget for one Brave request. Shorter than timeoutMs on purpose: a
		 * search is one small JSON call, and the agent waits with nothing to show.
		 */
		timeoutMs: 10_000,
		/**
		 * Extra attempts after a transient Brave failure (408, 429, 5xx, network
		 * error). The wait comes from Retry-After when Brave sends it, and the
		 * whole wait is capped by search.timeoutMs.
		 */
		maxRetries: 2,
		/** Results per query. Brave allows 1 to 20. */
		numResults: 5,
		/** Result pages fetched when includeContent is on and Brave gives no extra snippets. */
		contentCount: 3,
		/** Characters of page content kept per result when includeContent is on. */
		contentChars: 4_000,
		/**
		 * Budget for the whole web_search answer. Separate from maxInlineChars,
		 * and smaller: a result list is a menu to choose from, not a document.
		 * web_fetch reads any entry in full afterwards.
		 */
		maxOutputChars: 12_000,
		/**
		 * Brave extra_snippets (up to 5 excerpts per result, Pro plans only).
		 *   "auto" — ask for them, and stop asking after the API rejects them
		 *   "on"   — always ask, and report the rejection as an error
		 *   "off"  — never ask; includeContent always fetches the pages
		 */
		extraSnippets: "auto" as Tristate,
		/** Two letter country code, e.g. "pl". Empty means the Brave default. */
		country: "",
		/** Result language, ISO 639-1, e.g. "en". Empty means the Brave default. */
		searchLang: "",
		safesearch: "moderate" as SafeSearch,
	},

	pdf: {
		enabled: true,
		/** Pages read from one PDF. Later pages are reported as truncated. */
		maxPages: 50,
	},

	/**
	 * Short-lived memory of extracted pages. It pays for itself when web_search
	 * fetches a page that web_fetch then reads, and when the model pages through
	 * a long document with the offset parameter.
	 */
	cache: {
		enabled: true,
		/** Age at which an entry is discarded. 0 disables reuse. */
		ttlMs: 300_000,
		/** Entries held. The least recently used entry is evicted first. */
		capacity: 20,
		/** Pages longer than this are served but not stored. */
		maxChars: 250_000,
	},

	/**
	 * CIDR ranges exempt from the SSRF guard. Needed only for a TUN or fake-IP
	 * proxy that maps public names into a reserved range, e.g. ["198.18.0.0/15"].
	 */
	ssrf: { allowRanges: [] as string[] },

	/**
	 * Hostname policy for every fetched URL. deny wins over allow. A non-empty
	 * allow list blocks every hostname that is not on it. Subdomains match.
	 */
	domainPolicy: { allow: [] as string[], deny: [] as string[] },
};

// ─────────────────────────────── resolved shape ──────────────────────────────

export interface ResolvedConfig {
	braveApiKey: string | null;
	jinaApiKey: string | null;
	fetchChain: FetchEngine[];
	timeoutMs: number;
	maxResponseBytes: number;
	maxInlineChars: number;
	minUsefulChars: number;
	concurrency: number;
	userAgent: string;
	untrustedContentPrompt: boolean;
	jinaNoCache: boolean;
	search: {
		timeoutMs: number;
		maxRetries: number;
		numResults: number;
		contentCount: number;
		contentChars: number;
		maxOutputChars: number;
		extraSnippets: Tristate;
		country: string;
		searchLang: string;
		safesearch: SafeSearch;
	};
	pdf: { enabled: boolean; maxPages: number };
	cache: { enabled: boolean; ttlMs: number; capacity: number; maxChars: number };
	ssrf: { allowRanges: string[] };
	domainPolicy: { allow: string[]; deny: string[] };
}

let cachedConfigDir: string | undefined;

/** Resolve the pi agent directory the same way pi itself does. */
export function getConfigDir(): string {
	if (cachedConfigDir) return cachedConfigDir;

	const explicitDir = process.env.PI_CODING_AGENT_DIR;
	if (explicitDir) return cachedConfigDir = explicitDir;

	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome) {
		const xdgDir = join(xdgConfigHome, "pi");
		if (existsSync(join(xdgDir, CONFIG_FILENAME))) return cachedConfigDir = xdgDir;
		const legacyDir = join(homedir(), ".pi");
		if (existsSync(join(legacyDir, CONFIG_FILENAME))) return cachedConfigDir = legacyDir;
		return cachedConfigDir = xdgDir;
	}
	return cachedConfigDir = join(homedir(), ".pi", "agent");
}

const CONFIG_FILENAME = "web-rs.json";

export function getConfigPath(): string {
	return join(getConfigDir(), CONFIG_FILENAME);
}

let cachedFile: { signature: string; value: Record<string, unknown> } | null = null;

/** Read and cache the JSON file. The cache key is mtime plus size. */
function loadConfigFile(): Record<string, unknown> {
	const path = getConfigPath();
	if (!existsSync(path)) return {};

	let signature: string;
	try {
		const stat = statSync(path);
		signature = `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return {};
	}
	if (cachedFile?.signature === signature) return cachedFile.value;

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
	const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? parsed as Record<string, unknown>
		: {};
	cachedFile = { signature, value };
	return value;
}

/** Discard the file cache. Used by /webrs after it writes the file. */
export function clearConfigCache(): void {
	cachedFile = null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(Math.floor(value), maximum));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.filter((entry): entry is string => typeof entry === "string").map(entry => entry.trim()).filter(Boolean);
}

function asTristate(value: unknown, fallback: Tristate): Tristate {
	return value === "auto" || value === "on" || value === "off" ? value : fallback;
}

function asSafeSearch(value: unknown, fallback: SafeSearch): SafeSearch {
	return value === "off" || value === "moderate" || value === "strict" ? value : fallback;
}

/** Parse an engine list from a config value or a comma separated env var. */
export function parseFetchChain(value: unknown, fallback: FetchEngine[]): FetchEngine[] {
	const entries = typeof value === "string"
		? value.split(",")
		: Array.isArray(value) ? value : null;
	if (!entries) return fallback;

	const chain: FetchEngine[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const engine = entry.trim().toLowerCase();
		if ((engine === "http" || engine === "jina") && !chain.includes(engine)) chain.push(engine);
	}
	return chain.length > 0 ? chain : fallback;
}

function section(file: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = file[key];
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function loadConfig(): ResolvedConfig {
	const file = loadConfigFile();
	const search = section(file, "search");
	const pdf = section(file, "pdf");
	const cache = section(file, "cache");
	const ssrf = section(file, "ssrf");
	const domainPolicy = section(file, "domainPolicy");

	return {
		braveApiKey: asString(process.env.PI_WEB_RS_BRAVE_API_KEY) ?? asString(file.braveApiKey) ?? asString(process.env.BRAVE_API_KEY),
		jinaApiKey: asString(process.env.PI_WEB_RS_JINA_API_KEY) ?? asString(file.jinaApiKey) ?? asString(process.env.JINA_API_KEY),
		fetchChain: parseFetchChain(
			process.env.PI_WEB_RS_FETCH_CHAIN ?? file.fetchChain,
			DEFAULTS.fetchChain,
		),
		timeoutMs: asNumber(file.timeoutMs, DEFAULTS.timeoutMs, 1_000, 300_000),
		maxResponseBytes: asNumber(file.maxResponseBytes, DEFAULTS.maxResponseBytes, 64 * 1024, 100 * 1024 * 1024),
		maxInlineChars: asNumber(file.maxInlineChars, DEFAULTS.maxInlineChars, 1_000, 500_000),
		minUsefulChars: asNumber(file.minUsefulChars, DEFAULTS.minUsefulChars, 0, 10_000),
		concurrency: asNumber(file.concurrency, DEFAULTS.concurrency, 1, 10),
		userAgent: asString(file.userAgent) ?? DEFAULTS.userAgent,
		untrustedContentPrompt: asBoolean(file.untrustedContentPrompt, DEFAULTS.untrustedContentPrompt),
		jinaNoCache: asBoolean(file.jinaNoCache, DEFAULTS.jinaNoCache),
		search: {
			timeoutMs: asNumber(search.timeoutMs, DEFAULTS.search.timeoutMs, 1_000, 300_000),
			maxRetries: asNumber(search.maxRetries, DEFAULTS.search.maxRetries, 0, 5),
			numResults: asNumber(search.numResults, DEFAULTS.search.numResults, 1, 20),
			contentCount: asNumber(search.contentCount, DEFAULTS.search.contentCount, 1, 10),
			contentChars: asNumber(search.contentChars, DEFAULTS.search.contentChars, 200, 50_000),
			maxOutputChars: asNumber(search.maxOutputChars, DEFAULTS.search.maxOutputChars, 1_000, 200_000),
			extraSnippets: asTristate(search.extraSnippets, DEFAULTS.search.extraSnippets),
			country: asString(search.country) ?? DEFAULTS.search.country,
			searchLang: asString(search.searchLang) ?? DEFAULTS.search.searchLang,
			safesearch: asSafeSearch(search.safesearch, DEFAULTS.search.safesearch),
		},
		pdf: {
			enabled: asBoolean(pdf.enabled, DEFAULTS.pdf.enabled),
			maxPages: asNumber(pdf.maxPages, DEFAULTS.pdf.maxPages, 1, 1_000),
		},
		cache: {
			enabled: asBoolean(cache.enabled, DEFAULTS.cache.enabled),
			ttlMs: asNumber(cache.ttlMs, DEFAULTS.cache.ttlMs, 0, 3_600_000),
			capacity: asNumber(cache.capacity, DEFAULTS.cache.capacity, 1, 200),
			maxChars: asNumber(cache.maxChars, DEFAULTS.cache.maxChars, 1_000, 2_000_000),
		},
		ssrf: { allowRanges: asStringArray(ssrf.allowRanges, DEFAULTS.ssrf.allowRanges) },
		domainPolicy: {
			allow: asStringArray(domainPolicy.allow, DEFAULTS.domainPolicy.allow),
			deny: asStringArray(domainPolicy.deny, DEFAULTS.domainPolicy.deny),
		},
	};
}

/** The JSON template written by `/webrs init`. */
export function configTemplate(): Record<string, unknown> {
	return {
		braveApiKey: "",
		jinaApiKey: "",
		fetchChain: DEFAULTS.fetchChain,
		timeoutMs: DEFAULTS.timeoutMs,
		maxResponseBytes: DEFAULTS.maxResponseBytes,
		maxInlineChars: DEFAULTS.maxInlineChars,
		minUsefulChars: DEFAULTS.minUsefulChars,
		concurrency: DEFAULTS.concurrency,
		userAgent: DEFAULTS.userAgent,
		untrustedContentPrompt: DEFAULTS.untrustedContentPrompt,
		jinaNoCache: DEFAULTS.jinaNoCache,
		search: { ...DEFAULTS.search },
		pdf: { ...DEFAULTS.pdf },
		cache: { ...DEFAULTS.cache },
		ssrf: { allowRanges: [] },
		domainPolicy: { allow: [], deny: [] },
	};
}

/** Mask a secret for display. */
export function maskKey(value: string | null): string {
	if (!value) return "(not set)";
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
