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

## Iframe Eval (extension mode)

Cross-origin iframes need helper script:

```bash
argus iframe-helper --out src/argus-helper.js
argus eval app "window.gameState" --iframe "iframe#game"
```

Options: `--iframe <selector>`, `--iframe-namespace <name>`, `--iframe-timeout <ms>`

See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md).
