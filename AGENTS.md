# pi-web-rs — Agent Guidelines

## Purpose

A small web access extension for the Pi agent: Brave search and readable web fetch. It is a subset of pi-web-access, kept small on purpose.

## Architecture

| File | Responsibility |
|------|----------------|
| `index.ts` | Registers `web_search`, `web_fetch`, `/webrs`, and the untrusted-content system prompt; formats the tool output and the transcript rendering |
| `config.ts` | `DEFAULTS` block, `web-rs.json` loader, environment overrides, resolved config shape |
| `fetch.ts` | Engine chain: order, fallback, terminal-error stop, parallel fetches, cache lookup |
| `cache.ts` | Page cache: LRU with TTL, keyed by URL and engine choice |
| `extract.ts` | HTTP engine: Readability + Turndown, unpdf, text passthrough, size limits |
| `jina.ts` | Jina Reader engine: JSON envelope, text envelope fallback |
| `brave.ts` | Brave Search API, domain operators, extra_snippets plan detection |
| `find.ts` | In-page find with context windows |
| `ssrf.ts` | Outbound URL guard, redirect revalidation, domain policy |

## Rules that the tests enforce

- Every outbound URL goes through `ssrf.ts`, including the target of a Jina request
- Credentials in a URL and internal names are rejected before DNS is asked
- A terminal error (`isTerminalError`) must not start a second engine
- The Brave API key never appears in output or in an error message
- Every response body is read under a byte cap, search answers included
- `extra_snippets` is requested only when the caller wants content, and no more after the plan rejects it
- A domainFilter entry that cannot be applied is reported, never dropped in silence
- The output names every filter that was applied, and the method that applied it
- Over budget, `web_search` drops page content before it cuts the result list
- Only a complete extraction is cached; a failure is always retried
- A transient Brave status is retried; a permanent one is reported at once, and no wait may exceed `search.timeoutMs`
- Offset windows cover the text once: no gap, no overlap, and the offset always advances
- Config precedence is environment > file > `DEFAULTS`

## Testing

`npm test` runs 84 tests with no network access. New code needs the same seams: `fetchImpl` for the transport and `lookup` for DNS. A test must never depend on the user's `web-rs.json`; set `PI_CODING_AGENT_DIR` to a temporary directory instead.

`testConfig()` disables the page cache, because the cache lives for the life of the process and would carry a page from one test into the next. A test that needs the cache asks for it with `testConfig({ cache: { enabled: true } })` and calls `clearPageCache()` at both ends.
