# pi-web-rs — Agent Guidelines

## Purpose

A small web access extension for the Pi agent: Brave search and readable web fetch. It is a subset of pi-web-access, kept small on purpose.

## Architecture

| File | Responsibility |
|------|----------------|
| `index.ts` | Registers `web_search`, `web_fetch`, and `/webrs`; formats the tool output and the transcript rendering |
| `config.ts` | `DEFAULTS` block, `web-rs.json` loader, environment overrides, resolved config shape |
| `fetch.ts` | Engine chain: order, fallback, terminal-error stop, parallel fetches |
| `extract.ts` | HTTP engine: Readability + Turndown, unpdf, text passthrough, size limits |
| `jina.ts` | Jina Reader engine |
| `brave.ts` | Brave Search API, domain operators, extra_snippets plan detection |
| `find.ts` | In-page find with context windows |
| `ssrf.ts` | Outbound URL guard, redirect revalidation, domain policy |

## Rules that the tests enforce

- Every outbound URL goes through `ssrf.ts`, including the target of a Jina request
- A terminal error (`isTerminalError`) must not start a second engine
- The Brave API key never appears in output or in an error message
- `extra_snippets` is requested only when the caller wants content, and no more after the plan rejects it
- Config precedence is environment > file > `DEFAULTS`

## Testing

`npm test` runs 59 tests with no network access. New code needs the same seams: `fetchImpl` for the transport and `lookup` for DNS. A test must never depend on the user's `web-rs.json`; set `PI_CODING_AGENT_DIR` to a temporary directory instead.
