# Eval

Run JavaScript in the attached page (or selected iframe). `js` = `eval`, `wait` = `eval-until`.

```bash
argus eval app "location.href"
argus eval app "await fetch('/ping').then(r => r.status)"          # top-level await works
argus eval app "document.title" --json
argus eval app --expression "document.title"                       # same as positional
argus eval app --file ./script.js
argus eval app --file ./script.js --arg level=10 --arg mode=fast
argus eval app --file ./script.js --args ./args.json               # JSON object → args; --arg overrides
argus eval app "window.store.getState()" --inject ./debug-hooks.js # setup code runs first
cat script.js | argus eval app --stdin                             # or: argus eval app - < script.js
argus eval app "document.title" --json --out ./result.json
```

## Behavior Flags

| Flag                         | Effect                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `--timeout <duration>`       | Per-eval deadline enforced in the watcher (default 10s)                                 |
| `--no-await`                 | Do not await returned promises                                                          |
| `--no-return-by-value`       | Return a preview instead of a serialized value                                          |
| `--no-fail-on-exception`     | Exit 0 even when the expression throws                                                  |
| `--retry <n>`                | Retry failed evaluations                                                                |
| `-q, --silent`               | Print only on error                                                                     |
| `--inject <file>`            | Run this file before the expression                                                     |
| `--bundle` / `--no-bundle`   | Force / skip bundling of `--file` (auto when the file has `import`/`export`)            |
| `--arg k=v`, `--args <json>` | Frozen string `args` object visible to the script                                       |
| `-o, --out <path>`           | Write result to file (polling appends NDJSON; `--rotate` writes one file per iteration) |

Timeouts name their layer. Only `cdp_timeout` (the expression itself was too slow) is fixed by a longer `--timeout`; `chrome_unreachable`, `cdp_target_replaced`, `cdp_renderer_unresponsive`, and `dialog_blocking` need their own recovery ([SKILL.md](../SKILL.md#error--next-command)).

## Args

`args.*` are always strings; cast in the script. `--arg` splits at the first `=` (URLs with `=` are fine), later duplicates win, malformed values exit 2 before contacting the watcher. `--args <path>` loads a flat JSON object (primitives only; nested values rejected).

```js
const level = Number(args.level)
const variant = String(args.variant ?? 'arrows')
```

## Polling

```bash
argus eval app "document.title" --interval 250ms --until 'result === "ready"'   # --until sees {result, exception, iteration, attempt}
argus eval app "Date.now()" --interval 500 --count 10 --out ./poll.ndjson
argus eval app "Date.now()" --interval 500 --count 10 --out ./frames.json --rotate
```

`--json --interval` streams NDJSON (one document per iteration).

## `eval-until` / `wait`

Poll until `Boolean(result)` is true. Default interval 250ms, intermediate results silent.

```bash
argus wait app "document.querySelector('#loaded')"
argus wait app "window.APP_READY" --interval 500 --total-timeout 30s
argus wait app "await window.appReadyPromise"
argus wait app --file ./ready.js --arg level=10 --total-timeout 20s --out ./ready.json
argus wait app "window.data" --verbose --count 20
```

Flags: `--interval`, `--count`, `--total-timeout` (wall clock), `--verbose` (print falsy iterations), plus every `eval` behavior flag. Exit codes: 0 truthy, 1 error/exhausted, 2 invalid args, 130 interrupted.

## TypeScript Scenarios

A bundled `--file` whose default export is a function runs once with a typed page-side context and returns its result. Use this for deterministic multi-step suites instead of chaining many CLI calls.

```ts
import type { ArgusScenarioContext } from '@vforsh/argus'

export default async function scenario(ctx: ArgusScenarioContext) {
	const logs = await ctx.logs.session()
	await openLevel(Number(ctx.args.level))
	const checkpoint = await ctx.checkpoint('level-open', { selector: 'canvas' })
	await ctx.record.start('level-run', { selector: '#game', fps: 15 })
	await new Promise((r) => setTimeout(r, 3000))
	const clip = await ctx.record.stop()
	const errors = await logs.read({ levels: ['error', 'exception'] })
	return { checkpoint, clip, errors: errors.events }
}
```

```bash
argus eval game --file ./scenario.ts --arg level=10 --json
```

Context:

| Member                                       | Purpose                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ctx.args`                                   | Frozen string args                                                                                                         |
| `ctx.screenshot(opts?)`                      | Unique file under the watcher's `screenshots/`                                                                             |
| `ctx.checkpoint(name, opts?)`                | Deterministic `scenarios/checkpoints/<name>.png`                                                                           |
| `ctx.record.start(name, opts?)` / `.stop()`  | `scenarios/recordings/<name>.<fmt>`; opts mirror the CLI (`selector`, `clip`, `fps`, `format`, `quality`, `maxDurationMs`) |
| `ctx.logs.cursor()` / `.read(cursor, opts?)` | Zero-download baseline + delta read                                                                                        |
| `ctx.logs.session()`                         | Stateful reader; cursor advances after each `read()`                                                                       |

Bundling uses esbuild from your cwd (imports outside the entry dir and `node_modules` resolve; Node built-ins are rejected; TypeScript is transpiled, not type-checked). Scenario actions time out after 30s, so stop long recordings from the CLI. The binding is nonce-scoped and installed only for the eval's lifetime; page code cannot choose artifact paths. Bundled files without a default export keep final-expression semantics. For iframe scenarios select the iframe as the target ([IFRAMES.md](./IFRAMES.md)) rather than combining with `--iframe`.
