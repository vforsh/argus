# Runtime Code Inspection

Argus can inspect runtime JS/CSS resources exposed through CDP.

## Commands

```bash
argus code ls app
argus code ls app --pattern inline
argus code read http://127.0.0.1:3333/ --id app
argus code read inline://42 --id app --offset 20 --limit 80
argus code grep '/featureFlag/' --id app
argus code grep 'argusRuntimeProbe' --id app --url inline
argus code grep showLogsByHost --id app --pretty
argus code deminify http://127.0.0.1:3333/app.js --id app
argus code edit http://127.0.0.1:3333/app.js --id app --search "DEBUG=false" --replace "DEBUG=true"
argus code edit http://127.0.0.1:3333/app.js --id app --search '/logLevel\s*=\s*"info"/' --replace 'logLevel = "debug"' --all
argus code edit http://127.0.0.1:3333/app.js --id app --file ./patched.js
cat patched.css | argus code edit inline-css://1 --id app
argus code strings app --url app.js
argus code strings app --url app.js --kind url,identifier --match '/admin\\/api/'
```

## What It Does

- `code ls`: list runtime scripts/stylesheets discovered via CDP
- `code read`: return line-numbered source for one resource
- `code grep`: search sources with a plain string or `/regex/flags`
- `code grep --pretty`: render clipped context around each match, which is much nicer on minified bundles
- `code deminify`: pretty-print a runtime resource for quick inspection
- `code edit`: live-patch a runtime stylesheet via CDP (`CSS.setStyleSheetText`)
- `code strings`: extract high-signal string literals such as URLs, keys, and camelCase identifiers, with ranking tuned for reverse-engineering

## Behavior Notes

- Resource URLs can be real URLs or synthetic inline IDs like `inline://42` and `inline-css://style-sheet-1`.
- `code deminify` falls back to the original source if formatting fails.
- `code edit` supports three input modes: `--search/--replace` for surgical text replacement (with optional `--all`), `--file` for full source replacement from disk, and piped stdin. Search patterns use the same plain-string or `/regex/flags` format as `code grep`. JS script editing is not supported on Chrome 145+ (V8 removed `Debugger.setScriptSource`); use `argus eval` for runtime JS modifications instead.
- `code strings` favors signal over completeness by default. Use `--all` to include low-signal literals too.
- `code strings --kind` accepts a comma-separated subset of `url,key,identifier,message,other`.
- `code strings --match` reuses the same plain-string or `/regex/flags` pattern format as `code grep`.
- `code grep` skips stale stylesheet handles, emits a warning on stderr, and still returns matches from healthy resources. Details: [RUNTIME_CODE_STALE_STYLESHEET.md](./RUNTIME_CODE_STALE_STYLESHEET.md).
