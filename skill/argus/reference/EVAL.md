# Eval

Run JavaScript in the attached page (or selected iframe). `js` = `eval`, `wait` = `eval-until`.

## Probe: several reads, one round-trip

`probe` is the default way to read page state; reach for `eval` only for scripts. Each `name=expression` runs in its own try/catch inside one injected function, so one missing global cannot void the rest:

```bash
argus probe app url=location.href ready='!!window.appctl?.ads' view='getComputedStyle(document.querySelector("#view")).display'
# {"url":"http://…","ready":true,"view":{"__error":"TypeError: …"}}
argus probe app 'document.querySelectorAll(".row").length'        # bare expression → key _0
argus probe app score=appctl.score --until 'window.appctl?.ready' # wait, then read
argus probe app --stdin <<'EOF'
user=store.getState().user.id
cart=store.getState().cart.items.length
EOF
argus probe app --file ./probe.json --json                        # {"name": "expr", …}
```

- A throw → `{"__error": "ReferenceError: …"}` for that key only; exit 0 unless `--fail-on-exception`. Syntax errors are caught locally, values that cannot be serialized (cycles, `window`) per key. `undefined` → `null`.
- Promises are awaited (`--no-await` opts out). Keys must be unique; a trailing `;` is dropped.
- `--json` → the eval envelope `{ ok, result: {…}, type }`; `--fields`, `--max-chars`, `-q`, `--timeout`, `--retry`, `--until`, `--settle` work as on `eval`.
- No `JSON.stringify`, no `try/catch`, no `?.` chains needed.

```bash
argus eval app "location.href"
argus eval app "await fetch('/ping').then(r => r.status)"          # top-level await works
argus eval app "document.title" --json
argus eval app --expression "document.title"                       # same as positional
argus eval app --file ./script.js
argus eval app --file ./script.js --body            # async function body: await + return, local declarations
argus eval app --file ./script.js --arg level=10 --arg mode=fast
argus eval app --file ./script.js --args ./args.json               # JSON object → args; --arg overrides
argus eval app "window.store.getState()" --inject ./debug-hooks.js # setup code runs first
argus eval app --stdin <<'EOF'                                     # multi-line script, one turn, no scratch file
const rows = [...document.querySelectorAll('.row')]
rows.filter((row) => row.dataset.state === 'error').length
EOF
cat script.js | argus eval app --stdin                             # or: argus eval app - < script.js
argus eval app "document.title" --json --out ./result.json
```

## Behavior Flags

| Flag                         | Effect                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `--timeout <duration>`       | Per-eval deadline enforced in the watcher (default 10s)                                  |
| `--no-await`                 | Do not await returned promises                                                           |
| `--no-return-by-value`       | Return a preview instead of a serialized value                                           |
| `--body`                     | Treat input as an async function body; use an explicit `return`, declarations stay local |
| `--no-fail-on-exception`     | `eval`: exit 0 even when the expression throws (`eval-until` polls through throws already) |
| `--retry <n>`                | Retry failed evaluations                                                                 |
| `-q, --quiet`                | Print only on error (`--silent` still accepted)                                          |
| `--inject <file>`            | Run this file before the expression                                                      |
| `--bundle` / `--no-bundle`   | Force / skip bundling of `--file` (auto when the file has `import`/`export`)             |
| `--arg k=v`, `--args <json>` | Frozen string `args` object visible to the script                                        |
| `-o, --out <path>`           | Write result to file (polling appends NDJSON; `--rotate` writes one file per iteration)  |
| `--fields <a,b.c>`           | Project an object/array `result` to these dot paths (arrays: each element); stdout only  |
| `--max-chars <n>`            | Cap stdout; see below                                                                    |

`--fields` / `--max-chars` shape stdout only (also on `eval-until`); `--out` keeps the full result. Human mode prints the projected value and cuts it at `n` chars with a final `… [truncated N chars; raise --max-chars]` line. `--json` keeps one valid object: if the serialized `result` exceeds `n`, `result` becomes that serialized prefix (a string) and the reply adds `truncated: true, totalChars: <full length>`. Primitive results ignore `--fields`.

A result that is a `JSON.stringify`'d object or array comes back parsed in `--json` (`"decoded": "json"`, `type: "object"`, plus a one-line stderr hint) and before `--fields` in human mode, so `eval app 'JSON.stringify(x)' --json` needs no second `json.loads`. Returning the object itself is still shorter.

```bash
argus eval app "window.store.getState()" --json --fields user.id,cart.items.sku --max-chars 2000
```

Timeouts name their layer. Only `cdp_timeout` (the expression itself was too slow) is fixed by a longer `--timeout`; `chrome_unreachable`, `cdp_target_replaced`, `cdp_renderer_unresponsive`, `extension_bridge_unresponsive`, and `dialog_blocking` need their own recovery ([SKILL.md](../SKILL.md#error--next-command)). Extension-mode timeouts also name the stalled phase (`phase: … extension silent since` = worker/native channel stuck; `extension still active … this request is unanswered` = the command was still running).

Default eval uses Chrome's REPL semantics: statement-list completion values, top-level `await`, and repeated REPL `const`/`let` declarations work. Declarations share the page's global scope; bindings created by the page itself follow normal JavaScript redeclaration rules. Use `--body` for isolated locals and scripts containing `return`, or wrap the input in an async IIFE. `--body` works with inline/file/stdin input and `--arg`; bundled scenarios return from their default export instead. Successful output preserves the full serialized value, including nested objects, arrays, and long strings; `--no-return-by-value` explicitly requests a preview.

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

## Wait, Then Read (`--until` / `--settle` on reads)

Reads wait *before* reading: `eval`, `probe`, `dom info`, `dom tree`, `screenshot`, `snapshot`, `logs`, and `net` take `--until <page expr>` (`--until-timeout`, default 15s; a miss exits 1 with `wait_timeout` and nothing is read) and `--settle` (`--settle-timeout`, default 10s; a miss warns and reads anyway).

```bash
argus eval app "store.getState().cart" --until "window.store?.ready"   # replaces: sleep 3; eval …
argus screenshot app --out after.png --settle
argus logs app --after "$c" --levels error --settle
```

`eval --until` without `--interval` is this page-side wait; with `--interval` it stays the local stop condition over `result` (see Polling).

Hints: `eval` prints a one-line stderr `hint:` when the expression polls with `setTimeout`/`new Promise` (→ `wait` / `--until`) or wraps several keys in `JSON.stringify({…})` (→ `probe`). Hints never touch stdout.

## `eval-until` / `wait`

Poll until the value is truthy in JS terms (`undefined`, `NaN`, `-0`, `0n` count as falsy). A throw counts as "not yet" (same as action `--until`), so `argus wait app "appctl.ready()"` works while the app is still booting; `--fail-on-exception` stops on the first throw instead (exit 1). Default interval 250ms, intermediate results silent. After an action, prefer the action's own `--until`/`--settle` ([INTERACT.md](./INTERACT.md#wait-for-the-result---until)) over a separate `wait`.

`--settle` first waits for the page to stop moving (load, 500ms without open requests, `window.__argus.settle()`, two frames; `--settle-timeout`, default 10s). Alone (`argus wait app --settle`) that is the whole wait: JSON `{ ok: true, settle: { settled, elapsedMs, network, page } }`, and a page that never settles exits 1 with `wait_timeout`. Before an expression it is a warm-up: a miss only warns and polling starts anyway.

```bash
argus wait app --global appctl.ads                 # dotted global path is truthy
argus wait app --gone ".spinner"                   # no element matches
argus wait app --idle                              # = --settle with no expression
argus wait app "document.querySelector('#loaded')"
argus wait app --settle "window.store.ready" --total-timeout 30s
argus wait app "window.APP_READY" --interval 500 --total-timeout 30s
argus wait app "await window.appReadyPromise"
argus wait app --file ./ready.js --arg level=10 --total-timeout 20s --out ./ready.json
argus wait app "window.data" --verbose --count 20
```

Flags: `--interval`, `--count`, `--total-timeout` (wall clock), `--verbose` (print falsy and throwing iterations), `--fail-on-exception`, plus every other `eval` behavior flag. Without `--total-timeout`/`--count` a throwing expression polls forever. Exit codes: 0 truthy, 1 error/exhausted, 2 invalid args, 130 interrupted.

A miss reports what the expression last returned or threw: human `Total timeout exceeded (10s) after 40 polls; last: false`; JSON `{ ok: false, error: { code: "wait_timeout" | "wait_exhausted" }, iterations, elapsedMs, last: { result, type } | { exception } }`.

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
| `ctx.progress(value)`                        | Sync, fire-and-forget; the watcher keeps the latest JSON snapshot (≤ 8 MiB) as the result if the eval times out            |

**Partial results on timeout.** When a scenario misses `--timeout` after calling `ctx.progress()`, the eval returns that last value instead of losing everything. The response carries `timedOut: { code, message, progressAt }`, where `code`/`message` give the watcher's stall diagnosis (`cdp_timeout`, `dialog_blocking`, …). Human output prints the value and then the warning. `--json` and `--out` keep the full response. The exit code is 1. The value lives on the watcher, so it survives a page blocked by a native dialog. After a timeout the scenario is abandoned: its next `ctx` call throws, so it stops itself instead of running on in the page.

```ts
export default async function scenario(ctx: ArgusScenarioContext) {
	const samples = []
	for (const action of actions) {
		samples.push(await sampleFrames(action))
		ctx.progress({ done: samples.length, samples })   // cheap: call at step boundaries, not per frame
	}
	return samples
}
```

Bundling uses esbuild from your cwd (imports outside the entry dir and `node_modules` resolve; Node built-ins are rejected; TypeScript is transpiled, not type-checked). Scenario actions time out after 30s, so stop long recordings from the CLI. The binding is nonce-scoped and installed only for the eval's lifetime; page code cannot choose artifact paths. Bundled files without a default export keep final-expression semantics. For iframe scenarios select the iframe as the target ([IFRAMES.md](./IFRAMES.md)).
