# Plan: `argus text` — page text extraction for agents

## Problem

Agents currently pull page text via ad-hoc `argus eval app "document.body.innerText"`. That returns unstructured text, includes nav/footer/cookie noise, has no size limit (easy to dump 200k chars into context), and is rewritten differently every time. `dom tree`, `snapshot`, and `locate text` are built for structure/interaction, not reading.

## Goal

One command that returns the readable content of a page (or part of it) as **Markdown**, with a context budget, an outline→section workflow, grep, and iframe awareness. Markdown over plain text: headings/lists/code/tables/links give the agent structure for free.

## CLI surface

```bash
argus text app                          # main content → markdown (readability heuristic)
argus text app --selector "article"     # explicit container (also --testid, --ref)
argus text app --full                   # whole body, skip readability
argus text app --outline                # headings h1-h6 only, with anchors (TOC)
argus text app --section "Integrate"    # content under a heading until the next heading of same/higher level
argus text app --grep "/api key/i" -C 3 # matching lines with N lines of context
argus text app --max-chars 8000         # truncate + report remaining
argus text app --out page.md            # write to file; stdout gets path + stats only
argus text app --format md|text|json    # default md
argus text app --wait-for "article"     # wait for selector before extracting (SPA render)
argus text app --json
```

`argus text` is a top-level alias for `argus page text` (same pattern as `goto` → `page goto`).

## Priorities (ship in this order)

1. **Readability heuristic by default.** Pick `main` → `article` → `[role=main]` → else the block with the highest text density. Drop `nav`, `header`, `footer`, `aside`, `script`, `style`, `noscript`, `[aria-hidden=true]`, `[hidden]`, and elements not visible per `getComputedStyle` (`display:none`, `visibility:hidden`). This is ~80% of the value: a docs page becomes clean md without the sidebar. `--full` bypasses it; `--selector` overrides the root.

2. **`--outline` + `--section`.** Outline returns `[{ level, text, id }]` (id = element id or slug). Section resolves by exact heading text, then case-insensitive, then `/regex/`; ambiguous match fails with the candidate list. Outline-then-section is the primary workflow for long docs and must be documented as such in SKILL.md.

3. **Context budget as first-class.** Every response carries `{ chars, estimatedTokens, truncated, totalChars }` (`estimatedTokens ≈ chars / 4`). Default `--max-chars` 20000. On truncation the human output ends with a hint: use `--out`, `--section`, or `--grep`. Never dump unbounded text to stdout.

4. **`--grep` with context.** Regex or plain string over the extracted md lines; `-C <n>` context (default 2). Returns `[{ line, text, before[], after[] }]`. Cheaper than pulling the page when the question is "is X here and what's around it".

5. **Lossless links/code/tables.** `[text](href)` with absolute URLs (resolve against `document.baseURI`); `pre > code` → fenced block, language from `class="language-*"` / `lang-*`; `table` → md table (header from `thead` or first row); `img` → `![alt](src)`; inline `code`, `strong`, `em`; ordered/unordered lists with nesting; `br` → line break; `hr` → `---`; `blockquote` → `>`.

6. **Iframe-aware.** Runs against the selected extension target like `eval`. Under CDP, honors the watcher's frame selection. No special flag; same semantics the rest of Argus already has.

7. **`--wait-for <selector>`.** Poll for the selector (reuse `wait` semantics from the DOM target routes: default 0, `--timeout` bounds it) before extracting. Covers SPA render races; heavier polling stays with `eval-until`.

## Implementation

### Protocol — `packages/argus-core/src/protocol/http/text.ts` (new)

- `PageTextRequest`: `{ selector?, testid?, ref?, full?, outline?, section?, grep?, grepContext?, maxChars?, format?, waitFor?, timeout? }`.
- `PageTextResponse`: `{ url, title, root: { selector, strategy: 'main'|'article'|'role'|'density'|'selector'|'body' }, format, content?, outline?, matches?, stats: { chars, estimatedTokens, truncated, totalChars } }`.
- `PageTextRequestSchema` composed from `protocol/schemaFields.ts` readers, next to the type (POST bodies are schema-only).
- Additive change — no `ARGUS_PROTOCOL_VERSION` bump.

### Watcher

- Add `'text'` to `WATCHER_ENDPOINTS` (`packages/argus-watcher/src/http/endpoints.ts`).
- Route `packages/argus-watcher/src/http/routes/postText.ts`, wired in `router.ts`, `bodySchema: PageTextRequestSchema`.
- Extractor `packages/argus-watcher/src/cdp/text/` (keep each file < 500 LOC):
    - `extractScript.ts` — the in-page function as a string, executed via `Runtime.callFunctionOn` (root node) / `Runtime.evaluate`. Does root selection, visibility filtering, DOM walk → md, outline, section slicing. Runs inside the page so `getComputedStyle` is available; returns a JSON-serializable result.
    - `text.ts` — Node side: resolve target (reuse `defineDomTargetRoute` helpers for selector/testid/ref/wait), run script, apply `maxChars` truncation and grep on the watcher side (keeps the page-side payload simple and lets truncation report `totalChars`).
- No new dependencies (no turndown/readability/jsdom). Own DOM→md walker, ~300–400 LOC, covers the 95% case. `argus-core` stays dependency-free.
- Extension mode: the same script string goes through the existing eval bridge; nothing extension-specific except the route running through the selected target.

### CLI

- `packages/argus/src/commands/pageText.ts` via `defineWatcherCommand`. Human output: md to stdout; with `--out`, write file and print `path`, `chars`, `truncated`. `--outline` prints indented headings; `--grep` prints `line: text` blocks.
- Register in `packages/argus/src/cli/register/pageCommands.ts` as `page text`; add top-level alias `text` in `quickAccessCommands.ts` mirroring `gotoCommand`.
- Validation in `build`: `--section` and `--outline` mutually exclusive; `--max-chars` positive int; `--grep` + `-C` int ≥ 0.

### SDK / session

- `client.page.text(...)` in `packages/argus-client/src/client/createArgusClient.ts` with JSDoc.
- `text` command in `argus session` JSONL dispatch.

### Playground

- Add `<section data-testid="text-section">` to `playground/index.html`: an `<article>` with h2/h3 headings, nested lists, a fenced code block with `class="language-ts"`, a table, absolute + relative links, an image with alt, plus a `<nav>` and `<aside>` sibling and a `display:none` block that must be excluded.

### Tests

- `e2e/watcher-text.test.ts`: default readability picks `article`, excludes nav/aside/hidden; `--full` includes them; outline shape; section by exact/regex, ambiguous error; grep with context; truncation stats and `truncated: true`; links absolute; code fence language; table rendering; `--wait-for` on a delayed element; iframe target (same-origin iframe in playground).
- `e2e/page-cli.test.ts`: `argus text` alias, `--out` writes file, `--json` shape.
- Unit tests under `packages/argus-watcher/test/` for the md walker where it can run without a browser (pure helpers: slug, table formatting, truncation, grep).

### Docs

- `skill/argus/SKILL.md`: add `argus text app` and `argus text app --outline` to the Inspect Loop; replace any `eval ... innerText` guidance; document outline→section as the way to read long pages.
- `skill/argus/reference/INSPECT.md`: full flag reference and examples.
- `skill/argus/reference/SESSION.md`: `text` JSONL example.

## Later (not in this plan)

- `--diff` against the previous extraction (what changed after an action).
- `snapshot --text`: a11y tree with text nodes + refs, read-and-click in one command.
- `--links`: link list only, for site navigation.

## Final checklist

Run `npm run build:packages`, then `npm run typecheck` and `npm run lint` (`npm run lint:fix` for auto-fixable issues) and fix all errors. Run `npm run test:playground` and the new `e2e/watcher-text.test.ts`; update SKILL.md before merging.
