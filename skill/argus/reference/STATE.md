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

## IndexedDB

```bash
argus storage idb ls app                                   # alias of `storage indexeddb list`: databases, versions, stores, entry counts
argus storage idb get app save slots                       # one "<key>\t<value>" JSON line per entry (default 50)
argus storage idb get app save slots --limit 100 --skip 100   # page; stderr says when more remain
argus storage idb get app save slots --key 1 --json        # exact primary key: JSON number/array, else string ('"42"' forces a string)
argus storage idb clear app save slots                     # empty one store; omit the store to empty every store
argus storage idb delete app save                          # drop the database, even while the page holds it open
```

Runs in the selected target's origin; `--origin` guards like `storage local`. Values come back as JSON: Date → ISO string, binary → `{ type, byteLength }`, Map/Set → arrays. `delete` needs a CDP watcher (Chrome force-closes the page's connections); on extension watchers use `idb clear` or `storage clear --types indexeddb`. The page keeps its in-memory state, so reload after a reset.

## Reset The Origin

```bash
argus storage clear app --reload                           # everything for the page's origin, then reload: a first visit
argus storage clear app --types indexeddb,local_storage    # types: all (default), cookies, local_storage, indexeddb,
                                                           #   cache_storage, service_workers, file_systems, shared_storage, storage_buckets
argus storage clear app --reload --until "window.game?.ready" --until-timeout 60s
```

CDP `Storage.clearDataForOrigin`: works on CDP and extension watchers and drops IndexedDB databases the page holds open. A cross-site iframe with partitioned storage gets its own partition cleared (`storageKey` in `--json`), not the iframe origin's first-party data. `local_storage` covers sessionStorage too. `storage local clear` alone leaves IndexedDB saves behind. The browser HTTP cache is not origin data: add `argus net cache clear app` for a cold load.
