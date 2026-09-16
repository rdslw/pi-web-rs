# Upstream sync guide

pi-web-rs is a fork-down of **pi-web-access** (`github.com/nicobailon/pi-web-access`). It is not a diff of upstream: each module is a reduced rewrite. Merges are therefore manual and selective, and shall always update data in this document.

NB: some requirements or user needs my change, hence this document might contain wrong assumptions.

## Baseline

| Item | Value |
|------|-------|
| Upstream repo | `github.com/nicobailon/pi-web-access` |
| Baseline commit | `192ac18` — `chore(release): prepare v0.29.0`, 2026-09-10 |
| Baseline version | v0.29.0 |
| Forked on | 2026-09-14 |
| Target agent | pi 0.85.1, `@earendil-works/pi-*`, `typebox` |

## Provenance

| pi-web-rs | Upstream source | Relation |
|-----------|-----------------|----------|
| `extract.ts` | `extract.ts` (`extractViaHttp`, `isLikelyJSRendered`, `readResponseBufferWithLimit`, `isTextContentType`, `extractHeadingTitle`) | Reduced: no Defuddle, RSC, Jina, auth-fetch, proxy, image, video, declared-links, activity monitor |
| `extract.ts` PDF path | `pdf-extract.ts` (`getUnpdf`, unpdf branch of `extractPDFToMarkdown`) | Reduced to unpdf only; returns inline markdown instead of writing a file; no Gemini, no Datalab |
| `jina.ts` | `extract.ts` (`extractWithJinaReader`) | Same endpoint and envelope parsing; adds API key header, rate-limit message, and a body fallback when the envelope is absent |
| `brave.ts` | `brave.ts` | Same query building and domain filters; adds `extra_snippets` with plan detection, `text_decorations=0`, country and language; no `credential-source`, no `activity`, no `utils` |
| `ssrf.ts` | `ssrf-protection.ts` | Same address rules and redirect revalidation; no env-proxy trust, no loopback exemption, no config parsing (it takes options) |
| `find.ts` | `content-find.ts` | Near-verbatim port |
| `config.ts` | `utils.ts` (`getWebSearchConfigDir`), `pdf-extract.ts` (`loadPDFConfig`) | New file: `web-rs.json`, `DEFAULTS` block, environment precedence |
| `index.ts` | `index.ts` (`web_search` and `fetch_content` registration, `StringEnum`) | New file; only the registration shape and `StringEnum` are borrowed |
| `fetch.ts` | — | New. Upstream has no engine chain of this form |


## Deliberately absent

Search providers other than Brave · curator server and page · summary review · session storage and fetch cache · Chrome cookies and authenticated fetch · proxy transport · GitHub clone, issue, and PR tools · YouTube, video, and image handling · Gemini, Datalab, Firecrawl, Crawl4AI, Bright Data · source check · skills · `activity.ts`.

Do not merge these back. A new upstream provider or tool is out of scope by default; see the constraints in `AGENTS.md`.

## Sync procedure

```bash
cd ~/dev/pi-web-access
git pull --ff-only
OLD=192ac18                       # the baseline row above
git log --oneline $OLD..HEAD -- extract.ts brave.ts ssrf-protection.ts content-find.ts pdf-extract.ts
git diff $OLD..HEAD -- extract.ts brave.ts ssrf-protection.ts content-find.ts pdf-extract.ts
```

Read those five files plus `CHANGELOG.md`. Everything else in upstream is *probably* out of scope.

1. **Security first.** Any change in `ssrf-protection.ts` (new blocked range, redirect rule, parser fix) is a mandatory port.
2. **Extraction fixes.** Changes in `extractViaHttp` around content types, size limits, charset, or the Readability fallback are usually worth porting. Skip anything that needs Defuddle, RSC, proxy, or auth.
3. **Brave.** Port parameter and response-field changes. Keep the `extra_snippets` logic, which upstream does not have.
4. **Find.** `content-find.ts` is a near-verbatim port; copy the change and keep the local type names.
5. **PDF.** Only the unpdf branch matters.
6. After each port: `npm test && npm run typecheck`, then update the baseline commit in this file.

