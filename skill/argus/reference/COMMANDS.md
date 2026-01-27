# Common commands (cheat sheet)

This is a compact reference for the most-used Argus CLI commands once a watcher is running.

## Logs

One-shot history:

```bash
argus logs app --since 10m
argus logs app --levels error,warning
argus logs app --match "Unhandled|Exception" --ignore-case
argus logs app --source console
argus logs app --json
argus logs app --json-full
```

Tail (follow / long-poll):

```bash
argus tail app
argus tail app --levels error --json
argus tail app --timeout 30000 --limit 200
```

Notes:

- `tail` runs until Ctrl+C.
- `--json` / `--json-full` emit **NDJSON** (one JSON object per line).

## Eval

Full docs live in `EVAL.md`.

```bash
argus eval app "location.href"
argus eval app "await fetch('/ping').then(r => r.status)"
argus eval app "document.title" --json
```

## Screenshots

Full page:

```bash
argus screenshot app --out shot.png
```

Element-only:

```bash
argus screenshot app --selector "canvas" --out canvas.png
```

Note: `--out` is interpreted by the watcher (often relative to its artifacts dir). Use `--json` to see the resolved output path.

## Targets / pages

List targets (to find `targetId`):

```bash
argus page targets --id app
argus page targets --type page --id app
```

Open a new tab:

```bash
argus page open --url http://example.com --id app
argus page open --url localhost:3000 --id app
```

Reload:

```bash
argus page reload <targetId> --id app
```

Reload with query param overwrite:

```bash
argus page reload <targetId> --id app --param foo=bar --param baz=qux
argus page reload <targetId> --id app --params "a=1&b=2"
```

Notes:

- Query param updates only work for **http/https** targets.
- `--param` / `--params` use overwrite semantics (set/replace keys).
