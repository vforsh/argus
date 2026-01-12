# argus

CLI for querying Argus watchers.

## Install

```bash
npm install -g @vforsh/argus
```

## Usage

```bash
argus list
argus logs <id>
argus tail <id>
argus eval <id> "<expression>"
```

### Commands

- **`argus list`**: Discover running Argus watchers and their IDs.
    - Use this first to find the `<id>` you’ll pass to other commands (often something like `app`).
    - Tip: add `--json` for scripting.
    - Tip: add `--by-cwd <substring>` to filter watchers by their working directory.

- **`argus logs <id>`**: Fetch a bounded slice of log history for a watcher.
    - Best for “what already happened?” (e.g. “show me errors from the last 10 minutes”).
    - Combine with `--since`, `--levels`, `--match`, and `--source` to narrow results.

- **`argus tail <id>`**: Stream logs as they arrive (follow mode).
    - Best for “what’s happening right now?” while you reproduce an issue.
    - With `--json`, emits bounded newline-delimited JSON events (NDJSON) for piping into tools.
    - With `--json-full`, emits full NDJSON events (can be very large).

- **`argus eval <id> <expression>`**: Evaluate a JS expression in the connected page.
    - Best for quick one-off inspection (“what’s `location.href` right now?”).
    - Defaults: awaits returned promises; returns values “by value” when possible.
    - Tip: add `--json` for scripting (and check `.exception`).

#### `logs` vs `tail`

- **`logs`**: one-time query of **past** log events (bounded).
- **`tail`**: continuous stream of **new** log events (unbounded until you stop it).

#### `eval` gotchas / quirks

- **Shell quoting**: `<expression>` is a single CLI argument.
    - Use quotes for anything with spaces/special chars (zsh/bash): `argus eval app 'location.href'`.
    - If you need quotes _inside_ the expression, prefer swapping quote types or escaping.

- **“await” behavior**:
    - By default, Argus sets CDP `awaitPromise=true`, so if your expression **returns a Promise**, Argus waits for it and prints the resolved value.
    - You typically don’t need to use the `await` keyword—just return a Promise (e.g. `fetch("/ping").then(r => r.status)`).
    - With `--no-await`, Argus won’t wait; you’ll get a Promise-ish preview instead.

- **Return value shape is intentionally shallow**:
    - By default, Argus requests `returnByValue=true` (best effort “JSON-ish” values).
    - When a value can’t be returned by value, Argus falls back to a **bounded preview** (often shallow object properties, capped; nested objects are not expanded).
    - You may see truncation markers like `…: "+N more"`.
    - If you specifically want preview/remote-object behavior, use `--no-return-by-value`.

- **Exceptions don’t currently fail the process**:
    - If the evaluated expression throws, Argus prints `Exception: ...` but does **not** set a non-zero exit code.
    - For automation, use `--json` and treat `exception != null` as failure.

- **Timeouts**:
    - `--timeout <ms>` sets the watcher-side eval timeout (non-numeric / <= 0 is ignored).
    - The CLI HTTP request timeout includes a small buffer on top of the eval timeout.

- **Watcher registry cleanup**:
    - If the watcher can’t be reached, Argus removes it from the local registry (so it disappears from the next `argus list`).

### Options

- **`--json`**: output bounded, machine-readable JSON preview.
    - **What**: switches from human text formatting to JSON; for `tail`, this is newline-delimited JSON (NDJSON) so each event is one line.
    - **When**: when piping into tools like `jq`, writing to a file, or building scripts around Argus without risking megabytes-per-line.
    - **Why**: stable structure is easier to parse than terminal-friendly text, and large payloads stay capped.

- **`--json-full`**: output full, raw JSON.
    - **What**: emits the full event payload with no preview caps; for `tail`, this is NDJSON.
    - **When**: when you need exact fidelity and are ok with large output.
    - **Why**: preserves complete structures for deep debugging or archival.

- **`--levels <comma-separated>`**: filter by log severity.
    - **What**: only returns/emits events whose `level` is in the list (e.g. `error,warning`).
    - **When**: when you want to focus on signal (errors/warnings) and ignore noisy `log`/`debug` output.
    - **Why**: reduces volume so important events don’t get buried.

- **`--match <regex>`**: filter by message content (repeatable).
    - **What**: only returns/emits events whose text matches any provided regex pattern.
    - **When**: when you need server-side regex filtering (e.g. multiple tokens or alternation).
    - **Why**: reduces client-side `rg`/`tail` loops.

- **`--ignore-case` / `--case-sensitive`**: toggle regex case sensitivity.
    - **What**: controls how `--match` compares text.
    - **When**: when you need strict casing or want to avoid missing matches.
    - **Why**: keeps filtering predictable across environments.

- **`--source <substring>`**: filter by log source.
    - **What**: only returns/emits events whose `source` contains the given substring (e.g. `console`, `exception`, `system`).
    - **When**: when you only want console logs or only exceptions.
    - **Why**: reduces noise without post-processing.

- **`--by-cwd <substring>`**: filter watchers by working directory.
    - **What**: only returns watchers whose `cwd` contains the given substring.
    - **When**: when you have multiple watchers running and only care about those from a specific project or directory.
    - **Why**: reduces clutter in the `list` output.

- **`--since <duration>`**: time window (history).
    - **What**: limits results to events within the last duration (e.g. `10m`, `2h`, `30s`).
    - **When**: when you only care about “recent” history (typically with `logs`).
    - **Why**: avoids dumping an entire backlog when you only need the latest slice.

## Output

- Text output uses 4-character level tags (e.g. `LOG `, `DEBG`, `WARN`, `ERR `, `INFO`, `EXCP`).
- JSON output preserves the raw `level` values; `--json` uses bounded preview values, `--json-full` is raw.

## Examples

```bash
argus list --json
argus list --by-cwd my-project
argus logs app --since 10m --levels error,warning
argus logs app --match "\\[perf\\]" --match "OrderRewards|CustomerMakingOrderSelfService"
argus tail app --match "Unhandled"
argus eval app 'location.href'
argus eval app 'fetch("/ping").then(r => r.status)'
argus eval app 'document.title' --json | jq
```
