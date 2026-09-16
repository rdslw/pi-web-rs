/**
 * SSRF guard for every outbound URL the extension touches.
 *
 * A model can pass any URL to web_fetch. Without this guard the tool reaches
 * loopback services, RFC 1918 hosts, and cloud metadata endpoints such as
 * 169.254.169.254. The guard resolves the hostname, rejects reserved
 * addresses, and revalidates every redirect hop.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Names that only a local or cloud-internal resolver answers. The address check
 * below catches most of them, but a split-horizon or hostile resolver can return
 * a public address for an internal name. This list runs before DNS.
 */
const INTERNAL_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".home.arpa", ".lan"];

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

export interface DomainPolicy {
	allow: string[];
	deny: string[];
}

export interface GuardOptions {
	/** CIDR ranges exempt from the reserved-address check. */
	allowRanges?: string[];
	domainPolicy?: DomainPolicy;
	/** Test seam. Defaults to the system resolver. */
	lookup?: Lookup;
}

interface ParsedCidr {
	bytes: Uint8Array;
	prefix: number;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function validateRemoteUrl(rawUrl: string | URL, options: GuardOptions = {}): Promise<URL> {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched");
	}
	// The Jina engine puts the whole URL in the path of a third-party request,
	// so credentials in the URL would leave the machine.
	if (url.username || url.password) {
		throw new Error("Blocked credentials in URL: strip user:password@ from the address");
	}

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (isInternalHostname(hostname)) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}

	const allowRanges = parseAllowRanges(options.allowRanges);
	assertDomainPolicy(hostname, options.domainPolicy);

	if (net.isIP(hostname)) {
		assertPublicAddress(hostname, hostname, allowRanges);
		return url;
	}

	let addresses: LookupAddress[];
	try {
		addresses = await (options.lookup ?? defaultLookup)(hostname);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}
	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const { address } of addresses) assertPublicAddress(address, hostname, allowRanges);
	return url;
}

export interface FetchRemoteOptions extends GuardOptions {
	fetch?: typeof fetch;
	maxRedirects?: number;
}

/** fetch() with the guard applied to the first URL and to every redirect hop. */
export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<Response> {
	const fetchImpl = options.fetch ?? fetch;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	let current = await validateRemoteUrl(url, options);
	let requestInit = init;

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const response = await fetchImpl(current, { ...requestInit, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);

		current = await validateRemoteUrl(new URL(location, current), options);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isInternalHostname(hostname: string): boolean {
	return INTERNAL_HOSTNAMES.has(hostname) || INTERNAL_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

function domainMatches(hostname: string, entry: string): boolean {
	return hostname === entry || hostname.endsWith(`.${entry}`);
}

function assertDomainPolicy(hostname: string, policy?: DomainPolicy): void {
	if (!policy) return;
	if (policy.deny.some(entry => domainMatches(hostname, entry.toLowerCase()))) {
		throw new Error(`Blocked hostname by domainPolicy.deny: ${hostname}`);
	}
	if (policy.allow.length > 0 && !policy.allow.some(entry => domainMatches(hostname, entry.toLowerCase()))) {
		throw new Error(`Hostname not in domainPolicy.allow: ${hostname}`);
	}
}

function assertPublicAddress(address: string, hostname: string, allowRanges: ParsedCidr[]): void {
	const normalized = normalizeHostname(address);
	const version = net.isIP(normalized);
	if (version === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
	if (isInAllowedRange(normalized, version, allowRanges)) return;
	if (version === 4 && isBlockedIPv4(normalized)) {
		const hint = isFakeIpProxyAddress(normalized)
			? '. 198.18.0.0/15 is used by TUN/fake-IP proxies; add it to ssrf.allowRanges in web-rs.json if that matches your setup'
			: "";
		throw new Error(`Blocked internal address for ${hostname}: ${normalized}${hint}`);
	}
	if (version === 6 && isBlockedIPv6(normalized)) {
		throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
	}
}

function isFakeIpProxyAddress(address: string): boolean {
	const [a, b] = address.split(".").map(Number);
	return a === 198 && (b === 18 || b === 19);
}

function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		isFakeIpProxyAddress(address) ||
		a >= 224;
}

function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	if (groups.every(group => group === 0)) return true;
	if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true;
	const first = groups[0];
	if ((first & 0xfe00) === 0xfc00) return true;
	if ((first & 0xffc0) === 0xfe80) return true;

	const isMappedIPv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
	if (isMappedIPv4) {
		const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
		return isBlockedIPv4(ipv4);
	}
	return false;
}

function parseIPv6(address: string): number[] | null {
	if (address.includes(".")) {
		const lastColon = address.lastIndexOf(":");
		const ipv4 = address.slice(lastColon + 1);
		if (net.isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(Number);
		address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}

	const pieces = address.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;

	const groups = [...left, ...Array(missing).fill("0"), ...right].map(part => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return parseInt(part, 16);
	});
	return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : null;
}

function parseAllowRanges(input: string[] | undefined): ParsedCidr[] {
	if (!input?.length) return [];
	const rules: ParsedCidr[] = [];
	for (const entry of input) {
		const rule = parseCidr(entry.trim());
		if (!rule) throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
		rules.push(rule);
	}
	return rules;
}

function parseCidr(raw: string): ParsedCidr | null {
	if (!raw) return null;
	const slash = raw.lastIndexOf("/");
	const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
	const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
	// A slash must be followed by digits: Number("") is 0, which would turn
	// "10.0.0.0/" into /0 and exempt every address.
	if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;

	const version = net.isIP(addrPart);
	if (version === 4) {
		const bytes = ipv4ToBytes(addrPart);
		if (!bytes) return null;
		const prefix = prefixPart === null ? 32 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
		return { bytes, prefix };
	}
	if (version === 6) {
		const groups = parseIPv6(addrPart);
		if (!groups) return null;
		const prefix = prefixPart === null ? 128 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
		return { bytes: ipv6GroupsToBytes(groups), prefix };
	}
	return null;
}

function ipv4ToBytes(address: string): Uint8Array | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const value = Number(parts[i]);
		if (!Number.isInteger(value) || value < 0 || value > 255) return null;
		bytes[i] = value;
	}
	return bytes;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		bytes[i * 2] = groups[i] >> 8;
		bytes[i * 2 + 1] = groups[i] & 0xff;
	}
	return bytes;
}

function isInAllowedRange(address: string, version: number, rules: ParsedCidr[]): boolean {
	if (rules.length === 0) return false;
	const bytes = version === 4 ? ipv4ToBytes(address) : ipv6GroupsToBytes(parseIPv6(address) ?? []);
	if (!bytes || bytes.length === 0) return false;

	for (const rule of rules) {
		if (rule.bytes.length !== bytes.length) continue;
		if (matchesPrefix(bytes, rule)) return true;
	}
	return false;
}

function matchesPrefix(address: Uint8Array, rule: ParsedCidr): boolean {
	const fullBytes = rule.prefix >> 3;
	for (let i = 0; i < fullBytes; i++) {
		if (address[i] !== rule.bytes[i]) return false;
	}
	const remainingBits = rule.prefix & 7;
	if (remainingBits === 0) return true;
	const mask = 0xff << (8 - remainingBits) & 0xff;
	return (address[fullBytes] & mask) === (rule.bytes[fullBytes] & mask);
}
