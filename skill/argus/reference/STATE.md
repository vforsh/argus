# Auth State And Storage

## Cookies

```bash
argus auth cookies app                                    # list (alias of `auth cookies list`)
argus auth cookies app --for-origin --exclude-tracking    # first-party for the page, hide _ga/_ym…
argus auth cookies app --domain example.com --session-only --http-only --secure
argus auth cookies app --show-values --json               # values are previews unless --show-values
argus auth cookies get app session --domain .example.com --path / --show-value
argus auth cookies set app session token123 --domain .example.com --path / --secure --http-only --same-site Lax
argus auth cookies set app preview 1 --domain app.example.com --path / --session     # or --expires <unix|iso>
argus auth cookies delete app session --domain .example.com --path /
argus auth cookies clear app --for-origin                 # scopes: --for-origin | --site | --domain <d> | --browser-context
argus auth cookies clear app --site --auth-only           # --auth-only / --session-only narrow further
```

`get`/`set`/`delete` address a cookie by exact identity (name + domain + path).

## Export / Import Auth State

```bash
argus auth export-cookies app --format netscape --out cookies.txt   # netscape (default) | json | header
argus auth export-cookies app --for-origin --exclude-tracking --format header
argus auth export-state app --out auth.json                         # cookies + localStorage + sessionStorage + metadata
argus auth export-state app --domain example.com --out auth.json    # alias: auth export
argus auth load-state app --in auth.json [--url https://target.app/]   # alias: auth load; hydrates the attached tab
argus auth clone ext-2 --to app [--url …]                           # watcher → watcher, no file
argus chrome start --auth-state auth.json                           # fresh temp profile pre-hydrated
argus start --id app --auth-from ext-2 --url https://target.app/    # clone + launch + attach
```

Typical flow: attach the extension to the logged-in tab, `auth export-state` (or `--auth-from`), then drive an isolated CDP Chrome with that session. Hydration owns the first navigation; `--url` overrides where it lands.

## localStorage / sessionStorage

```bash
argus storage local ls app
argus storage local get app theme
argus storage local set app theme dark
argus storage local set app config '{"debug":true}'
argus storage local remove app theme
argus storage local clear app
argus storage session get|set|remove|ls|clear app …       # same verbs
argus storage local ls app --origin https://app.example   # guard: fail unless the page origin matches
```

Runs in the selected target's origin. Values are strings; JSON is stored as text.
