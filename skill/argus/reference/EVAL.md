# argus eval

Evaluate JavaScript in page connected to watcher.

Alias: `argus js`

## Syntax

```bash
argus eval [id] "<expression>" [flags]
argus js [id] "<expression>" [flags]
```

## Examples

```bash
argus eval app "location.href"
argus eval app "document.title"
argus eval app "await fetch('/ping').then(r => r.status)"
argus eval app "window.store.getState()" --inject ./debug-hooks.js
argus eval app --file ./script.js --arg level=10 --arg mode=fast
argus eval app --file ./script.js --args ./args.json
argus eval app "document.title" --json --out ./result.json
argus eval app --file ./script.js --bundle
argus eval app --file ./script.js --no-bundle
```

`--file` with leading `import`/`export` auto-enables bundling (one-line stderr note). `--bundle` forces bundling; `--no-bundle` reads the file as-is. Bundling resolves the entry and any import graph esbuild can resolve from the current working directory (including paths outside the entry directory and packages under `node_modules`). Node built-ins (`node:fs`, etc.) are rejected. TypeScript is transpiled without typechecking. Helpers may `export` symbols; the entry file must not emit top-level `export` into the bundle.

Poll until condition:

```bash
argus eval app "document.title" --interval 250ms --until 'result === "ready"'
argus eval app "Date.now()" --interval 500 --count 10 --out ./poll.ndjson
argus eval app "Date.now()" --interval 500 --count 10 --out ./frames.json --rotate
```

## Output

- Default: compact preview
- `--json`: JSON object (NDJSON with `--interval`)
- `--out <path>`: write result to file; single eval overwrites, polling appends NDJSON, `--rotate` writes one numbered file per iteration

## Behavior Flags

| Flag                     | Effect                              |
| ------------------------ | ----------------------------------- |
| `--no-await`             | Don't await promises                |
| `--timeout <duration>`   | Eval timeout (`60000`, `60s`, `2m`) |
| `--no-return-by-value`   | Preview-style results               |
| `--no-fail-on-exception` | Don't exit 1 on throw               |
| `--retry <n>`            | Retry failed evals                  |
| `--silent` / `-q`        | Suppress success output             |
| `--inject <file>`        | Run setup code before expression    |
| `--bundle`               | Force bundling for `--file`         |
| `--no-bundle`            | Skip bundling (disables auto)       |
| `--arg <key=value>`      | Expose string arg as `args[key]`    |
| `--args <path>`          | Load args map from JSON file        |
| `--out <path>`           | Write result to file                |
| `--rotate`               | One file per poll iteration         |

## Script Args

`--arg <key=value>` is repeatable on `eval`/`js` and `eval-until`/`wait`. It exposes a frozen `args` object to the evaluated source:

```bash
argus js app --file ./open-level.js --arg level=10 --arg variant=arrows
argus js app --file ./open-level.js --args ./fixtures/level.json --arg variant=arrows
argus js app "window.store.getState()" --inject ./debug-hooks.js --arg user=qa
cat ./click-test-id.js | argus js app --stdin --arg testId=arrows.boosters.button.ruler
argus wait app --file ./ready.js --arg level=10 --total-timeout 20s
```

Values stay strings; cast in the script:

```js
const level = Number(args.level)
const variant = String(args.variant ?? 'arrows')
```

Duplicate keys use the last value. Values are split at the first `=`, so URLs and query strings work. Invalid values like `--arg level`, `--arg =10`, or `--arg ""` exit with code 2 before contacting the watcher.

`--args <path>` loads a JSON object from disk. Primitive values (`string`, `number`, `boolean`, `null`) are coerced to strings; nested objects/arrays are rejected. CLI `--arg` flags override file entries.

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
argus wait app --file ./ready.js --arg level=10 --total-timeout 20s
```

| Flag                         | Effect                                  |
| ---------------------------- | --------------------------------------- |
| `--interval <ms\|duration>`  | Polling interval (default: 250ms)       |
| `--count <n>`                | Max iterations                          |
| `--total-timeout <duration>` | Max wall-clock time (`30s`, `2m`, `1h`) |
| `--verbose`                  | Print intermediate (falsy) results      |

Also supports all behavior flags (`--no-await`, `--timeout 60s`, `--json`, `--retry`, etc.) and iframe flags.
Also supports `--arg <key=value>`, `--args <path>`, and `--out <path>`.

**Exit codes:** 0 = truthy found, 1 = error/exhausted, 2 = invalid args, 130 = SIGINT/SIGTERM.

**vs `eval --interval --until`:** `eval-until` defaults interval to 250ms, uses implicit `Boolean(result)` condition, suppresses intermediate output by default, and adds `--total-timeout`.

## Iframe Eval (extension mode)

Cross-origin iframes need helper script:

```bash
argus eval iframe-helper --out src/argus-helper.js
argus eval app "window.gameState" --iframe "iframe#game"
```

Options: `--iframe <selector>`, `--iframe-namespace <name>`, `--iframe-timeout <duration>` (`5000`, `5s`, `1m`)

See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md).
