# Runtime Code

Inspect and patch the JS/CSS Chrome actually loaded (including inline scripts and stylesheets), via CDP. Resource URLs are real URLs or synthetic ids like `inline://42` and `inline-css://style-sheet-1` as printed by `code ls`.

```bash
argus code ls app                                        # scripts + stylesheets
argus code ls app --pattern inline
argus code read http://127.0.0.1:3333/app.js --id app --offset 20 --limit 80    # line-numbered
argus code grep '/featureFlag/i' --id app                # plain string or /regex/flags
argus code grep showLogsByHost --id app --url app.js --pretty                   # clipped context; great on minified bundles
argus code deminify http://127.0.0.1:3333/app.js --id app
argus code strings app --url app.js                      # ranked URLs, keys, identifiers, messages
argus code strings app --kind url,identifier --match '/admin\/api/' --min-length 6 --limit 500 --all
argus code edit inline-css://1 --id app --search "DEBUG=false" --replace "DEBUG=true" [--all]
argus code edit http://127.0.0.1:3333/app.css --id app --file ./patched.css
cat patched.css | argus code edit inline-css://1 --id app
```

- `read`, `grep`, `deminify`, `edit` take the resource URL positionally and the watcher via `--id`; `ls` and `strings` take the watcher positionally.
- `code edit` live-patches **stylesheets** (`CSS.setStyleSheetText`). Editing JS is not supported on Chrome 145+ (V8 dropped `Debugger.setScriptSource`); use `argus eval` for runtime JS changes.
- `code strings` favors signal over completeness; `--all` includes low-signal literals. Kinds: `url,key,identifier,message,other`.
- `code grep` skips stale stylesheet handles with a stderr warning and still returns the rest. `deminify` falls back to the original source if formatting fails.
