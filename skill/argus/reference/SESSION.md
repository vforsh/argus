# Session Transport

`argus session <id>` serves many commands from one process over stdin/stdout. Each one-shot `argus` call pays Node startup plus watcher discovery (~100–200ms); a session pays it once. Use it when a harness issues dozens of sequential commands against one watcher.

```bash
argus session app
argus session app --request-timeout 30s      # default 120s; 0 disables
argus session app --reconnect                # survive watcher restarts under the same id
echo '{"id":1,"cmd":"eval","args":{"expression":"location.href"}}' | argus session app
```

Every request runs the same Commander action as the CLI with `--json` forced on, so `result` matches `argus <cmd> --json` byte for byte.

## Framing

stdin: one JSON object per line. stdout: one JSON object per line, nothing else (human output → stderr). First line, before any request is read:

```json
{ "type": "ready", "protocolVersion": 1, "argusVersion": "0.5.10", "watcher": { "id": "app", "host": "127.0.0.1", "port": 51733 } }
```

### Request

| Field     | Type             | Notes                                                             |
| --------- | ---------------- | ----------------------------------------------------------------- |
| `id`      | string \| number | Echoed on the response. Omit only if you match by order.          |
| `cmd`     | string           | Command path, space-separated; aliases work (`js`, `ext`, `wait`) |
| `args`    | object           | Named arguments (exclusive with `argv`)                           |
| `argv`    | string[]         | Raw CLI tokens (exclusive with `args`)                            |
| `timeout` | string \| number | Per-request watchdog (`"30s"` or ms); `0` disables                |

```json
{"id": 1, "cmd": "eval", "args": {"expression": "location.href"}}
{"id": 2, "cmd": "eval-until", "args": {"expression": "window.APP_READY", "totalTimeout": "30s"}}
{"id": 3, "cmd": "click", "args": {"selector": "button.submit", "waitNav": "load"}}
{"id": 4, "cmd": "drag", "argv": ["--selector", "canvas", "--pos", "320,240", "--by", "80,-30"]}
{"id": 5, "cmd": "screenshot", "args": {"out": "./shot.png"}}
{"id": 6, "cmd": "dom tree", "args": {"selector": "body", "depth": 2}}
{"id": 7, "cmd": "storage local set", "args": {"key": "theme", "value": "dark"}}
{"id": 8, "cmd": "page show", "args": {"policy": "background"}}
{"id": 9, "cmd": "page hide", "args": {"activate": false}}
```

`args` resolve against the command's own definition:

- Options by camelCase, long flag, or short flag (`totalTimeout`, `total-timeout`, `q`).
- Positionals by declared name (`key`/`value`, `role`, `expression`) in declaration order; the watcher id is injected.
- An option beats a positional of the same name.
- Repeatable options take arrays (`{"arg": ["level=10", "mode=fast"]}`); switches take booleans (`{"await": false}` → `--no-await`).

### Response

```json
{"id": 1, "ok": true, "result": {"ok": true, "result": "https://app.example/", "type": "string", "exception": null}, "durationMs": 8}
{"id": 2, "ok": false, "error": {"message": "Total timeout exceeded (30s)", "code": "session_command_failed"}, "exitCode": 1, "durationMs": 30014}
```

- `result` is the command's `--json` document. NDJSON streams (`eval --interval`) come back as an array with `"stream": true`; non-JSON output as a string with `"raw": true`.
- `stderr` is included when the command wrote any (also mirrored live to the session's stderr).
- Control: `{"cmd": "ping"}` → `{"pong": true, "watcher": "app"}`; `{"cmd": "quit"}` answers then exits 0.

## Semantics

- **Ordering**: strictly in submission order; pipelining is fine.
- **Timeouts**: a request past its watchdog answers `session_request_timeout` and the session moves on; the abandoned command's later output is discarded.
- **Error isolation**: malformed line / unknown command / failing command → `ok: false`, session stays up. Transport codes: `session_invalid_request`, `session_unknown_command`, `session_command_rejected`, `session_request_timeout`, `session_command_failed`. Watcher-side codes pass through unchanged.
- **Watcher loss**: default fail-fast (probe after a failure, exit 1 if gone). `--reconnect` re-resolves the id on every request.
- **Shutdown**: `quit` or EOF exits 0. Queued requests after that are unanswered; fail them host-side.

## Refused (`session_command_rejected`)

Daemons (`start`, `chrome start`, `watcher start`, `watcher native-host`), streams (`logs tail`, `net tail`, `net sse`), nested `session`, and anything reading `--stdin` or a `-` expression. Use `--file` or inline expressions. `page open --attach` is not refused but never returns — run it as its own process too.

## Host Sketch

```js
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const proc = spawn('argus', ['session', 'app'], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let nextId = 0
readline.createInterface({ input: proc.stdout }).on('line', (line) => {
	const msg = JSON.parse(line)
	if (msg.type === 'ready') return
	pending.get(msg.id)?.(msg)
	pending.delete(msg.id)
})
const run = (cmd, args) =>
	new Promise((resolve) => {
		const id = ++nextId
		pending.set(id, resolve)
		proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
	})

await run('eval-until', { expression: 'window.APP_READY', totalTimeout: '30s' })
await run('click', { selector: 'button.start' })
proc.stdin.end()
```
