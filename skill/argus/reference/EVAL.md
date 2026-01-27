# `argus eval`

Evaluate a JavaScript expression in the page currently connected to an Argus watcher.

This is the fastest way to inspect state, call functions, or run quick probes without opening DevTools.

## Syntax

```bash
argus eval [id] "<expression>" [flags]
```

- `id` is the watcher id (e.g. `app`, `extension`). If only one watcher is reachable, many setups work without an explicit id.
- `<expression>` is a JavaScript expression or snippet evaluated in the page context.

## Common examples

```bash
argus eval app "location.href"
argus eval app "document.title"
argus eval app "await fetch('/ping').then(r => r.status)"
```

Poll until a condition is met (local condition; runs on your machine, not in the browser):

```bash
argus eval app "document.title" --interval 250ms --until 'result === "ready"'
```

## Output modes

- **Default (human)**: prints a compact preview of the result (or a formatted exception).
- **`--json`**:
    - single eval: prints one JSON object
    - with `--interval`: prints **NDJSON** (one JSON object per line)

## Flags (behavior)

- **`--no-await`**: do not await returned promises.
- **`--timeout <ms>`**: eval timeout (also used for the watcher request).
- **`--no-return-by-value`**: disable `returnByValue` (use preview-style results instead of forcing JSON-serializable values).
- **`--no-fail-on-exception`**: do not exit with code 1 when the page evaluation throws (you still get the exception printed).
- **`--retry <n>`**: retry failed evaluations up to \(n\) times (retries transport failures and exceptions when `--no-fail-on-exception` is not used).
- **`--silent` / `-q`**: suppress success output; only emit output on error.

## Re-evaluation / polling

Use these together:

- **`--interval <ms|duration>`**: re-run periodically (`500`, `250ms`, `3s`, `2m`).
- **`--count <n>`**: stop after \(n\) iterations (**requires** `--interval`).
- **`--until <condition>`**: stop when condition becomes truthy (**requires** `--interval`).

`--until` runs locally with context:

```ts
{
	;(result, exception, iteration, attempt)
}
```

Stop a running `--interval` loop with Ctrl+C (SIGINT).

## Iframe eval (extension mode)

In **extension mode**, cross-origin iframes can’t be evaluated directly due to browser security boundaries. Argus supports iframe eval via a `postMessage` bridge:

```bash
argus iframe-helper --out src/argus-helper.js
argus eval app "window.gameState" --iframe "iframe#game"
```

Iframe options:

- **`--iframe <selector>`**: CSS selector for iframe to eval in via postMessage (requires helper script).
- **`--iframe-namespace <name>`**: message type prefix (default: `argus`).
- **`--iframe-timeout <ms>`**: timeout waiting for iframe response (default: `5000`).

See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md) for the full workflow, message format, and security notes.
