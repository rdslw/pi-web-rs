# Install

Installation methods, requirements, and dependency details for pi-web-rs.

## Requirements

- **Node.js >= 23** (required for `Promise.try`, used by `unpdf`)
- **Pi coding agent**

## Installation Methods

### 1. `pi install git:` — Standard production install

Recommended for most users. Pi manages the package lifecycle and runs production installation automatically.

```bash
pi install git:github.com/<you>/pi-web-rs@v0.1.0
```

pi clones to `~/.pi/agent/git/github.com/<you>/pi-web-rs`, runs `npm install --omit=dev` inside the clone, and records the source in `~/.pi/agent/settings.json` under `packages`. Add `-l` to record it in the project's `.pi/settings.json` instead.

The ref is pinned. `pi update --extensions` reconciles the clone to the pinned tag but never moves it; update to a newer release with `pi install git:…@v0.2.0`. Use `pi list` to see installed packages, and `pi remove git:…` to uninstall.

### 2. `pi install <path>` — Local development loop

For developing or testing local edits directly from your clone without copying files:

```bash
pi install ~/dev/pi-web-rs        # adds the local path to settings.json; copies nothing
pi -e ~/dev/pi-web-rs/index.ts    # one run only, nothing is recorded
```

A local path is registered, not copied: pi loads directly from the work tree and every edit is live after `/reload`. Dependencies resolve against the repository's `node_modules` (run `npm install` in the repo first). pi runs no `npm install` for a local path: it only checks that the path exists, so dependencies must already be present.

### 3. Export with `npm pack` — Isolated manual install

Installs into Pi's auto-discovery directory `~/.pi/agent/extensions/pi-web-rs` without touching `settings.json`.

`npm pack` honours the `files` field of `package.json`, so only runtime files ship (8 source files, documentation, `package.json` — ~25 kB packed). `npm install` then adds the five runtime dependencies in the destination.

```bash
SRC=~/dev/pi-web-rs                      # the work tree
DST=~/.pi/agent/extensions/pi-web-rs     # the destination

cd "$SRC" && TGZ=$(npm pack --silent)
rm -rf "$DST" && mkdir -p "$DST"
tar -xzf "$TGZ" --strip-components=1 -C "$DST" && rm -f "$TGZ"
cd "$DST" && npm install --omit=dev --omit=optional
```

Result: about 17 MB, 20 packages. No `test/`, no `tsconfig.json`, no TypeScript compiler. pi discovers the directory on its own because `~/.pi/agent/extensions/*/index.ts` beside a `package.json` with a `"pi"` key is a discovery path. Nothing is written to `settings.json`.

> **Note:** Do not skip the `npm install` step. pi never installs dependencies for a discovered directory; without `node_modules` the extension fails to load at its first `p-limit` import and registers no tools.

### 4. Export with `git archive` — Offline / unpushed commits

Exports the committed git tree into the extension directory without needing a remote:

```bash
DST=~/.pi/agent/extensions/pi-web-rs
rm -rf "$DST" && mkdir -p "$DST"
git -C ~/dev/pi-web-rs archive --format=tar HEAD | tar -x -C "$DST"
cd "$DST" && npm install --omit=dev --omit=optional
```

Use this when the repository has commits that are not pushed to a remote yet.

## Dependencies & Footprint

Runtime dependencies:
- `@mozilla/readability` — readability extraction for HTML pages
- `linkedom` — lightweight DOM parser for readability
- `turndown` — converts extracted HTML to clean markdown
- `unpdf` — PDF text extraction (pure JS, no binary worker)
- `p-limit` — concurrency control for parallel fetches and searches

### Dependency Rules

**Never register a path that auto-discovery already covers.** A directory in `~/.pi/agent/extensions/` plus the same path in `settings.json` loads the extension twice and registers `web_search` and `web_fetch` twice.

**`--omit=dev` is what keeps the install small.** The development tree is about 217 MB because `npm install` adds the pi packages, `typebox`, and the TypeScript compiler with its 27 MB native binary. None of them are needed at run time: pi supplies `typebox`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to every extension through its loader alias map (declared as optional peer dependencies in `package.json`), and pi never compiles TypeScript. Method 1 (`pi install`) applies `--omit=dev` automatically.

**`--omit=optional` is safe.** The only optional dependency is `@napi-rs/canvas`, which `unpdf` uses to render PDF images. pi-web-rs extracts PDF text only and never renders images.

**Runtime footprint:** `npm install --omit=dev --omit=optional` installs only the five runtime packages and their direct sub-dependencies: **~17 MB, 20 packages**.

## Verify

```bash
pi
/webrs            # prints the config, the active fetch chain, and whether Brave is ready
```

`/webrs` is unavailable if the extension failed to load; start pi with `--verbose` to see the loader error.

## Configure

```
/webrs init       # writes ~/.pi/agent/web-rs.json, mode 0600
```

Then set `braveApiKey` in `~/.pi/agent/web-rs.json`, or export `BRAVE_API_KEY`. `web_fetch` works with no key.
