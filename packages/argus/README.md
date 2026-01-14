# argus

CLI for querying Argus watchers.

## Install

```bash
npm install -g @vforsh/argus
```

## Usage

```bash
argus list
argus logs [id]
argus tail [id]
argus eval [id] "<expression>"
argus page <subcommand>
argus chrome <subcommand>
argus watcher list
argus watcher status [id]
argus watcher stop [id]
argus watcher start --id <id> --url <pattern>
argus doctor
```

### Commands

- **`argus list`**: Discover registered Argus watchers and their IDs.
    - Use this first to find the `<id>` you'll pass to other commands (often something like `app`).
    - Tip: add `--json` for scripting.
    - Tip: add `--by-cwd <substring>` to filter watchers by their working directory.
    - Tip: use `argus watcher prune` to remove unreachable watchers from the registry.

- **`argus logs [id]`**: Fetch a bounded slice of log history for a watcher.
    - Best for “what already happened?” (e.g. “show me errors from the last 10 minutes”).
    - Combine with `--since`, `--levels`, `--match`, and `--source` to narrow results.
    - If `<id>` is omitted, Argus tries the watcher in your current `cwd`, then the only reachable watcher.

- **`argus tail [id]`**: Stream logs as they arrive (follow mode).
    - Best for “what’s happening right now?” while you reproduce an issue.
    - With `--json`, emits bounded newline-delimited JSON events (NDJSON) for piping into tools.
    - With `--json-full`, emits full NDJSON events (can be very large).

- **`argus eval [id] <expression>`**: Evaluate a JS expression in the connected page.
    - Best for quick one-off inspection (“what’s `location.href` right now?”).
    - Defaults: awaits returned promises; returns values “by value” when possible.
    - Tip: add `--json` for scripting (and check `.exception`).
    - Tip: add `--no-fail-on-exception` to keep exit code 0 when the expression throws.

#### Chrome commands

Manage and query a running Chrome instance with remote debugging enabled (CDP).

- **`argus chrome start`**: Launch Chrome with CDP enabled.
    - Options: `--url <url>`, `--id <watcherId>`, `--default-profile`, `--json`.
    - Example: `argus chrome start --url http://localhost:3000`.
    - Note: `--default-profile` launches Chrome with a copied snapshot of your default profile.
    - Why: recent Chrome versions require a non-default user data dir to expose `--remote-debugging-port`, so Argus copies your default profile into a temp directory and launches Chrome from that copy (keeps your real default profile closed + untouched).
    - Reference:
        ```
        https://developer.chrome.com/blog/remote-debugging-port
        ```

- **`argus chrome version`**: Show Chrome version info from the CDP endpoint.
    - Options: `--cdp <host:port>`, `--id <watcherId>`, `--json`.

- **`argus chrome status`**: Check if Chrome CDP endpoint is reachable.
    - Prints `ok <host>:<port> <browser>` on success; exits with code 1 if unreachable.

- **`argus chrome stop`**: Close the Chrome instance via CDP.
    - Alias: `quit`.
    - Example: `argus chrome stop`.

#### Page commands

Manage tabs/targets via CDP (aliases: `tab`).

- **`argus page targets`**: List all Chrome targets (tabs, workers, extensions).
    - Aliases: `list`, `ls`.
    - Options: `--type <type>` to filter (e.g. `--type page` for tabs only), `--json`.
    - Example: `argus page targets --type page`.

- **`argus page open --url <url>`**: Open a new tab in Chrome.
    - Alias: `new`.
    - URL normalization: if no scheme, `http://` is prepended.
    - Example: `argus page open --url localhost:3000`.

- **`argus page activate [targetId]`**: Activate (focus) a Chrome target.
    - Fuzzy selection: `--title`, `--url`, or `--match` (case-insensitive substring).
    - If multiple matches and TTY: interactive picker. If non-TTY: prints candidates and exits 2.
    - Example: `argus page activate --title "Docs"`.

- **`argus page close <targetId>`**: Close a Chrome target.
    - Example: `argus page close E63A3ED201BFC02DA06134F506A7498C`.

- **`argus page reload [targetId]`**: Reload a Chrome target.
    - Use `--attached --id <watcherId>` to reload the attached page without a target ID.
    - Use `--param`/`--params` to update query params before reload.
    - Example: `argus page reload --attached --id app`.

**CDP endpoint resolution** (applies to `chrome version/status/stop` and all `page` commands):

- `--cdp <host:port>`: Use explicit host/port.
- `--id <watcherId>`: Use chrome config from a registered watcher's `chrome.host`/`chrome.port`.
- Default: `127.0.0.1:9222`.
- `--cdp` and `--id` are mutually exclusive.

#### Watcher commands

Also available via `argus watchers` (plural alias).

- **`argus watcher list`**: Same output as `argus list`, but namespaced under `watcher`.
    - Aliases: `ls`.
    - Example: `argus watcher list --by-cwd my-project`.

- **`argus watcher status [id]`**: Check whether a watcher is reachable.
    - Alias: `ping`.
    - Example: `argus watcher status app`.

- **`argus watcher stop [id]`**: Ask a watcher to shut down (falls back to SIGTERM).
    - Alias: `kill`.
    - Example: `argus watcher stop app`.

- **`argus watcher start`**: Start an Argus watcher process.
    - Required: `--id <watcherId>`, `--url <pattern>`.
    - Optional: `--chrome-host <host>` (default: `127.0.0.1`), `--chrome-port <port>` (default: `9222`), `--no-page-indicator`, `--json`.
    - Note: the in-page watcher indicator badge is enabled by default.
    - Example: `argus watcher start --id app --url localhost:3000 --chrome-port 9223`.

- **`argus watcher prune`**: Remove unreachable watchers from the registry.
    - Alias: `clean`.
    - Options: `--by-cwd <substring>` to filter candidates, `--dry-run` to preview without removing, `--json`.
    - Examples:
        - `argus watcher prune`
        - `argus watcher prune --by-cwd my-project`
        - `argus watcher prune --dry-run`
        - `argus watcher prune --dry-run --json`

#### Diagnostics

- **`argus doctor`**: Run environment diagnostics for registry, watchers, WebSocket availability, Chrome bin, and CDP.
    - Tip: add `--json` for scripting.

#### Watcher selection defaults

For commands that accept `[id]`:

- If `<id>` is provided, Argus uses it.
- Else if exactly one watcher has `cwd === process.cwd()`, Argus uses it.
- Else if exactly one reachable watcher exists, Argus uses it.
- Otherwise Argus exits with an error and lists candidates (TTY prompts are only used for page target selection, not watcher IDs).

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

- **Exceptions fail the process by default**:
    - By default, exceptions set exit code 1 and are routed to stderr.
    - Use `--no-fail-on-exception` to keep exit code 0 and treat exceptions as successful output.
    - For automation, prefer `--json` and check `.exception`.

- **Timeouts**:
    - `--timeout <ms>` sets the watcher-side eval timeout (non-numeric / <= 0 is ignored).
    - The CLI HTTP request timeout includes a small buffer on top of the eval timeout.

- **Watcher registry cleanup**:
    - Argus does **not** remove watchers on single failures by default.
    - Use `argus watcher prune` to explicitly remove unreachable watchers from the registry.
    - Use `argus watcher prune --dry-run` to preview what would be removed.

#### `eval` options

- **`--no-fail-on-exception`**: keep exit code 0 when the evaluation throws.
- **`--retry <n>`**: retry failed evaluations (transport failures always; exceptions only when `--no-fail-on-exception` is not set).
- **`-q, --silent`**: suppress success output; still emits errors.
- **`--interval <ms|duration>`**: re-evaluate on a fixed cadence (e.g. `500`, `250ms`, `3s`).
- **`--count <n>`**: stop after N iterations (requires `--interval`).
- **`--until <condition>`**: stop when local condition becomes truthy (requires `--interval`).
    - Evaluated locally in Node with context `{ result, exception, iteration, attempt }`.
    - **Warning**: executes arbitrary local JS; don’t paste untrusted input.

### Options

- **`--json`**: output machine-readable JSON.
    - **What**: switches from human text formatting to JSON.
    - **Streaming**: commands that can emit multiple objects use **NDJSON** (one JSON object per line).
    - **Stderr**: when `--json` is set, all non-machine logs go to **stderr**.
    - **When**: when piping into tools like `jq`, writing to a file, or building scripts around Argus.
    - **Why**: stable structure is easier to parse than terminal-friendly text.

- **`--json-full`**: output full, raw JSON.
    - **What**: emits the full event payload with no preview caps; for streaming commands this is NDJSON.
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
    - **When**: when you only care about "recent" history (typically with `logs`).
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
argus eval app 'throw new Error("boom")'
argus eval app '1+1' --silent
argus eval app 'Date.now()' --interval 500 --count 3
argus eval app 'document.title' --interval 250 --until 'result === "argus-e2e"'

# Chrome commands
argus chrome status --cdp 127.0.0.1:9222
argus chrome version --json
argus chrome stop

# Page commands
argus page targets --type page
argus page ls --type page --json
argus page open --url localhost:3000
argus page activate --title \"Docs\"
argus page close E63A3ED201BFC02DA06134F506A7498C
argus page reload --attached --id app

# Watcher with custom Chrome port
argus chrome start --json  # note the cdpPort in output
argus watcher start --id app --url localhost:3000 --chrome-port 9223
argus doctor
```
