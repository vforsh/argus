# Session Transport

`argus session` serves many commands from one process over stdin/stdout. Use it when a harness
issues dozens of sequential commands against the same watcher: each one-shot `argus` invocation
pays Node startup plus watcher discovery (~100-200ms), and the session pays it once.

```bash
argus session app
argus session app --request-timeout 30s
argus session app --reconnect
```

The watcher id is resolved once and pinned. Every request runs the same Commander action the
one-shot CLI would run, with `--json` forced on, so payloads match `argus <cmd> --json` byte for
byte and a host can switch transports without changing how it parses results.

---

## Framing

stdin takes one JSON object per line; stdout answers with one JSON object per line and nothing
else. Human output goes to stderr.

The first line is written before any request is read:

```json
{ "type": "ready", "protocolVersion": 1, "argusVersion": "0.4.0", "watcher": { "id": "app", "host": "127.0.0.1", "port": 51733 } }
```

### Request

| Field     | Type             | Notes                                                              |
| --------- | ---------------- | ------------------------------------------------------------------ |
| `id`      | string \| number | Optional; echoed on the response. Omit only if you match by order. |
| `cmd`     | string           | Command path, space-separated. Aliases work (`js`, `ext`, `wait`). |
| `args`    | object           | Named arguments. Mutually exclusive with `argv`.                   |
| `argv`    | string[]         | Raw CLI tokens. Mutually exclusive with `args`.                    |
| `timeout` | string \| number | Per-request watchdog (`"30s"`, or milliseconds). `0` disables.     |

```json
{"id": 1, "cmd": "eval", "args": {"expression": "location.href"}}
{"id": 2, "cmd": "eval-until", "args": {"expression": "window.APP_READY", "totalTimeout": "30s"}}
{"id": 3, "cmd": "click", "args": {"selector": "button.submit"}}
{"id": 4, "cmd": "drag", "argv": ["--selector", "canvas", "--pos", "320,240", "--by", "80,-30"]}
{"id": 5, "cmd": "screenshot", "args": {"out": "./shot.png"}}
{"id": 6, "cmd": "dom tree", "args": {"selector": "body", "depth": 2}}
```

`args` keys are resolved against the command's own definition, so anything the CLI accepts is
reachable:

- **Options** match by camelCase name, long flag, or short flag: `totalTimeout`, `total-timeout`,
  and `q` all work.
- **Positional arguments** match by their declared name (`key`/`value` for `storage local set`,
  `role` for `locate role`) and are filled in declaration order. The leading watcher id is
  injected for you.
- **An option wins over a positional of the same name.** `{"expression": "…"}` on `eval` becomes
  `--expression`, the spelling the CLI already documents as equivalent to the positional.
- **Repeatable options** take an array: `{"arg": ["level=10", "mode=fast"]}`.
- **Switches** take a boolean: `{"all": true}`, `{"await": false}` (which sends `--no-await`).

### Response

```json
{"id": 1, "ok": true, "result": {"ok": true, "result": "https://app.example/", "type": "string", "exception": null}, "durationMs": 8}
{"id": 2, "ok": false, "error": {"message": "Total timeout exceeded (30s)", "code": "session_command_failed"}, "exitCode": 1, "durationMs": 30014}
```

- `result` is the command's `--json` document. A command that streams newline-delimited JSON
  (`eval --interval`) yields an array plus `"stream": true`; output that is not JSON at all comes
  back verbatim as a string plus `"raw": true`.
- `stderr` is present when the command wrote any, on success or failure. It is also mirrored to
  the session's own stderr, so a human tailing the process still sees it live.
- `durationMs` is the wall-clock time the CLI spent on the request.

### Control requests

| `cmd`  | Effect                                                       |
| ------ | ------------------------------------------------------------ |
| `ping` | Answers `{"pong": true, "watcher": "<id>"}` without any I/O. |
| `quit` | Answers, then closes the session with exit code 0.           |

---

## Semantics

**Ordering.** Requests are served strictly in submission order. Pipelining still pays off — the
host can keep writing while a command is in flight — but responses arrive in the order the
requests did.

**Timeouts.** A request that outlives its watchdog is answered with `session_request_timeout` and
the session moves on. The abandoned command keeps its own output buffer, so nothing it writes
later can land in a later response.

**Error isolation.** A malformed line, an unknown command, or a failing command answers
`ok: false` and the session stays up. The `error.code` values specific to this transport are
`session_invalid_request`, `session_unknown_command`, `session_command_rejected`,
`session_request_timeout`, and `session_command_failed`; a watcher-side failure carries its own
code through unchanged.

**Watcher loss.** By default the session is fail-fast: after a failed request it probes the
watcher, and if the watcher is gone it writes a notice to stderr and exits `1`. Pass `--reconnect`
to keep it alive instead — every request re-resolves the id through the registry, so a watcher
restarted under the same id (even on a new port) is picked up on the next request.

**Shutdown.** `{"cmd": "quit"}` or EOF on stdin exits `0`. Requests still queued on stdin when the
session exits — after a `quit`, or after watcher loss — are not answered; fail them on the host
side when the process exits.

---

## Not available in a session

Commands that never return on their own, or that would read the stream the transport owns, are
refused with `session_command_rejected`:

- `start`, `chrome start`, `watcher start`, `watcher native-host` — daemons; run them as their own
  process and point the session at the resulting watcher.
- `logs tail`, `net tail`, `net sse` — stream until interrupted.
- `session` — no nesting.
- Any request carrying `--stdin` or a `-` expression. Use `--file` or an inline expression.

---

## Host sketch

```js
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const proc = spawn('argus', ['session', 'app'], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = readline.createInterface({ input: proc.stdout })
const pending = new Map()
let nextId = 0

lines.on('line', (line) => {
	const message = JSON.parse(line)
	if (message.type === 'ready') return
	pending.get(message.id)?.(message)
	pending.delete(message.id)
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
