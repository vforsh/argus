# Runtime Code

Inspect and patch the JS/CSS Chrome actually loaded (including inline scripts and stylesheets), via CDP. Resource URLs are real URLs or synthetic ids like `inline://42` and `inline-css://style-sheet-1` as printed by `code ls`.

```bash
argus code ls app                                        # scripts + stylesheets
argus code ls app --pattern inline
argus code read app http://127.0.0.1:3333/app.js --offset 20 --limit 80    # line-numbered
argus code grep app '/featureFlag/i'                     # plain string or /regex/flags
argus code grep app showLogsByHost --url app.js --pretty                   # clipped context; great on minified bundles
argus code grep app fetchBoard --url bundle --around 80 --max-per-line 5   # excerpt per match with column
argus code deminify app http://127.0.0.1:3333/app.js
argus code strings app --url app.js                      # ranked URLs, keys, identifiers, messages
argus code strings app --kind url,identifier --match '/admin\/api/' --min-length 6 --limit 500 --all
argus code edit app inline-css://1 --search "DEBUG=false" --replace "DEBUG=true" [--all]
argus code edit app http://127.0.0.1:3333/app.css --file ./patched.css
cat patched.css | argus code edit app inline-css://1
```

- Every `code` subcommand takes the watcher id first, like other commands: `code grep [id] <pattern>`, `code read|deminify|edit [id] <url>`. A lone positional is the pattern/url (watcher auto-resolved). `--id <watcher>` still works; giving both with different values exits 2.
- `code edit` live-patches **stylesheets** (`CSS.setStyleSheetText`). Editing JS is not supported on Chrome 145+ (V8 dropped `Debugger.setScriptSource`); use `argus eval` for runtime JS changes.
- `code strings` favors signal over completeness; `--all` includes low-signal literals. Kinds: `url,key,identifier,message,other`.
- `code grep` reports lines over 2000 chars (minified bundles) as excerpts: one result per match (≤10 per line, `--max-per-line`) with 200 chars of context each side, printed as `url:line:column` with `…` where the line was cut. `--around <chars>` excerpts every line with that context. JSON excerpts carry `column`, `matchLength`, and `excerpt: {start, end, lineLength}`; short lines keep the whole `lineContent`.
- `code grep` skips stale stylesheet handles with a stderr warning and still returns the rest. `deminify` falls back to the original source if formatting fails.
- `deminify` lazily loads Oxfmt for native JS/CSS formatting (80-column output, independent of project config). Parse/import/native-binding errors preserve the original source and report a formatting error. Oxfmt requires Node ^20.19.0 or >=22.12.0 and its platform binding; keep optional dependencies enabled when installing. `grep --pretty` adds context without loading the formatter.
