# Upstream sync guide

pi-web-rs has two sources. **pi-web-access** is the ancestor: each module here is a reduced rewrite of one there, so a merge is manual and selective, never a diff. **@counterposition/pi-web-search** is a design source only: no code is merged from it.

This file records what came from where, and guides the next port. Every merge shall update it.

NB: requirements or user needs my change in the future, hence this document might contain wrong assumptions and every merge shall be user guided.

## Sources

| | pi-web-access | pi-web-search |
|---|---|---|
| Location | `github.com/nicobailon/pi-web-access` | npm `@counterposition/pi-web-search` |
| Read at | `192ac18`, v0.29.0, 2026-09-10 | 0.5.3 |
| Licence | MIT | **GPL-3.0-only** |
| Relation | Ancestor, rewritten from | Comparison, written against |
| Taken on | 2026-09-14, the fork | 2026-09-17, a review |

Target agent: pi 0.85.1, `@earendil-works/pi-*`, `typebox`.

## From pi-web-access

Per file. Logic added later is marked **Local**, because a port shall keep it.

| Local file | Upstream source | Relation |
|-----------|-----------------|----------|
| `extract.ts` | `extract.ts` (`extractViaHttp`, `isLikelyJSRendered`, `readResponseBufferWithLimit`, `isTextContentType`, `extractHeadingTitle`) | Reduced: no Defuddle, RSC, Jina, auth-fetch, proxy, image, video, declared-links, activity monitor |
| `extract.ts` PDF path | `pdf-extract.ts` (`getUnpdf`, unpdf branch of `extractPDFToMarkdown`) | Reduced to unpdf only; returns inline markdown instead of writing a file; no Gemini, no Datalab |
| `jina.ts` | `extract.ts` (`extractWithJinaReader`) | Same endpoint; adds API key header and rate-limit message. **Local:** JSON envelope first with the text envelope as fallback, bounded body read |
| `brave.ts` | `brave.ts` | Same query building and domain filters; adds `extra_snippets` with plan detection, `text_decorations=0`, country and language. **Local:** `result_filter=web`, `page_age` dates, transient-failure retry, applied-filter reporting, bounded body read |
| `ssrf.ts` | `ssrf-protection.ts` | Same address rules and redirect revalidation; no env-proxy trust, no loopback exemption, no config parsing (it takes options). **Local:** URL credentials rejected, internal-name suffix deny list before DNS |
| `find.ts` | `content-find.ts` | Near-verbatim port. Unchanged since the fork |
| `config.ts` | `pdf-extract.ts` (`loadPDFConfig`) | New file: `web-rs.json`, `DEFAULTS` block, environment precedence. **Local:** the file path comes from pi's `getAgentDir()`, not from upstream `getWebSearchConfigDir` (no XDG or `~/.pi` fallback) |
| `index.ts` | `index.ts` (`web_search` and `fetch_content` registration, `StringEnum`) | New file; only the registration shape and `StringEnum` are borrowed |
| `fetch.ts` | — | New. Upstream has no engine chain of this form |
| `cache.ts` | — | New, 2026-09-17. Upstream has a fetch cache, but it was left out at the fork and this is not a port of it |

**Not taken.** Search providers other than Brave · curator server and page · summary review · session storage · Chrome cookies and authenticated fetch · proxy transport · GitHub clone, issue, and PR tools · YouTube, video, and image handling · Gemini, Datalab, Firecrawl, Crawl4AI, Bright Data · source check · skills · `activity.ts`.

## From pi-web-search

Per commit, six passes on 2026-09-17. Design only. The commit messages carry the reasoning of record.

| Commit | Adopted |
|--------|---------|
| `6aeaaa6` | Untrusted-content system prompt · URL credentials rejected · internal-name suffix list · bounded response bodies · dropped domain filters reported |
| `6fe3853` | `result_filter=web` · `X-Retain-Images: none` · absolute publication dates from `page_age` · one fetch per URL across queries · split search and fetch timeouts |
| `153c44d` | LRU page cache with a TTL · `offset` pagination for `web_fetch` |
| `b2a8803` | Transient-failure classification (408, 429, 5xx) with a `Retry-After` wait |
| `c4089c5` | Jina JSON envelope, so a failed target names its cause |
| `f2ad785` | Search output budget, separate from `maxInlineChars` · per-query filter notes |

New config keys, all with in-source defaults: `untrustedContentPrompt`, `jinaNoCache`, `search.timeoutMs`, `search.maxRetries`, `search.maxOutputChars`, and the `cache` section. New tool parameter: `web_fetch.offset`.

**Not taken.** The multi-provider search interface with Tavily and Exa. One search provider is a standing decision: the cost is a new abstraction plus two vendors, in a fork whose purpose is to stay small. The retry loop in `brave.ts` is the accepted compensation — a Brave hiccup no longer ends a search, though a Brave outage still does. Reopen only on a user request, not because the source adds a provider.

**Licence boundary.** GPL-3.0-only, so **its code must not be copied into this MIT project**. What was taken is observed behaviour, API facts, and design decisions; every module was written against this codebase's own structure and naming. The window threshold in `sliceBoundary` is chosen locally; do not align it with the source.

**Still ahead here.** Do not regress these when porting from either source: the SSRF guard resolves the hostname and revalidates every redirect hop, where pi-web-search checks the URL text only; PDF extraction, multi-URL fetch, `find` with a fuzzy mode, the TUI renderers, the `/webrs` command, and redaction of the API key from error text have no counterpart there.

## Porting

Get the sources:

```bash
# Ancestor: the diff since the commit in the Sources table.
cd ~/dev/pi-web-access.github/ && git pull --ff-only
git diff 192ac18..HEAD -- extract.ts brave.ts ssrf-protection.ts content-find.ts pdf-extract.ts

# Design source: the published package.
cd /tmp && npm pack @counterposition/pi-web-search && tar xzf counterposition-pi-web-search-*.tgz
```

The whole scope is those five upstream files plus its `CHANGELOG.md`, and for the package `README.md`, `extensions/web-search.ts`, and `src/`.

Read the local file before the upstream one. `brave.ts`, `jina.ts`, `ssrf.ts`, and `index.ts` carry enough local logic that a port belongs inside them, never over them.

Then ask. Present what the diff holds and what looks worth taking, and let the user settle the list before any file changes. Ask a second time about anything that outlives the port — a config key, a tool parameter, the shape of tool output, an item from a "Not taken" list — because those reach the user's own setup, and the cost of a wrong guess is theirs. A security fix is the one thing not in question: report it and port it, and let the user shape how rather than whether.

Code may be copied from pi-web-access. None may be copied from pi-web-search: read it, take the design, and write it here in this codebase's own terms.

Close with `npm test && npm run typecheck`, update the Sources table and whichever section above the change belongs to, and say what was taken, what was left, and why.
