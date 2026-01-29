# argus eval

Evaluate JavaScript in page connected to watcher.

## Syntax

```bash
argus eval [id] "<expression>" [flags]
```

## Examples

```bash
argus eval app "location.href"
argus eval app "document.title"
argus eval app "await fetch('/ping').then(r => r.status)"
```

Poll until condition:

```bash
argus eval app "document.title" --interval 250ms --until 'result === "ready"'
```

## Output

- Default: compact preview
- `--json`: JSON object (NDJSON with `--interval`)

## Behavior Flags

| Flag                     | Effect                  |
| ------------------------ | ----------------------- |
| `--no-await`             | Don't await promises    |
| `--timeout <ms>`         | Eval timeout            |
| `--no-return-by-value`   | Preview-style results   |
| `--no-fail-on-exception` | Don't exit 1 on throw   |
| `--retry <n>`            | Retry failed evals      |
| `--silent` / `-q`        | Suppress success output |

## Polling Flags

| Flag                    | Effect                              |
| ----------------------- | ----------------------------------- |
| `--interval <duration>` | Re-run periodically (`250ms`, `3s`) |
| `--count <n>`           | Stop after n iterations             |
| `--until <condition>`   | Stop when truthy                    |

`--until` context: `{ result, exception, iteration, attempt }`

## eval-until

Poll until expression returns truthy (`Boolean(result)`). Defaults to 250ms interval; silent intermediate output.

```bash
argus eval-until [id] "<expression>" [flags]
```

```bash
argus eval-until app "document.querySelector('#loaded')"
argus eval-until app "window.APP_READY" --interval 500
argus eval-until app "document.title === 'Ready'" --total-timeout 30s
argus eval-until app "window.data" --verbose --count 20
argus eval-until app --file ./check.js --total-timeout 1m
```

| Flag                         | Effect                                  |
| ---------------------------- | --------------------------------------- |
| `--interval <ms\|duration>`  | Polling interval (default: 250ms)       |
| `--count <n>`                | Max iterations                          |
| `--total-timeout <duration>` | Max wall-clock time (`30s`, `2m`, `1h`) |
| `--verbose`                  | Print intermediate (falsy) results      |

Also supports all behavior flags (`--no-await`, `--timeout`, `--json`, `--retry`, etc.) and iframe flags.

**Exit codes:** 0 = truthy found, 1 = error/exhausted, 2 = invalid args, 130 = SIGINT/SIGTERM.

**vs `eval --interval --until`:** `eval-until` defaults interval to 250ms, uses implicit `Boolean(result)` condition, suppresses intermediate output by default, and adds `--total-timeout`.

## Iframe Eval (extension mode)

Cross-origin iframes need helper script:

```bash
argus iframe-helper --out src/argus-helper.js
argus eval app "window.gameState" --iframe "iframe#game"
```

Options: `--iframe <selector>`, `--iframe-namespace <name>`, `--iframe-timeout <ms>`

See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md).
