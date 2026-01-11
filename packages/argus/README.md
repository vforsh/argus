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
```

### Commands

- **`argus list`**: Discover running Argus watchers and their IDs.
    - Use this first to find the `<id>` you’ll pass to other commands (often something like `app`).
    - Tip: add `--json` for scripting.

- **`argus logs <id>`**: Fetch a bounded slice of log history for a watcher.
    - Best for “what already happened?” (e.g. “show me errors from the last 10 minutes”).
    - Combine with `--since`, `--levels`, and `--grep` to narrow results.

- **`argus tail <id>`**: Stream logs as they arrive (follow mode).
    - Best for “what’s happening right now?” while you reproduce an issue.
    - With `--json`, emits newline-delimited JSON events (NDJSON) for piping into tools.

#### `logs` vs `tail`

- **`logs`**: one-time query of **past** log events (bounded).
- **`tail`**: continuous stream of **new** log events (unbounded until you stop it).

### Options

- **`--json`**: output machine-readable JSON.
    - **What**: switches from human text formatting to JSON; for `tail`, this is newline-delimited JSON (NDJSON) so each event is one line.
    - **When**: when piping into tools like `jq`, writing to a file, or building scripts around Argus.
    - **Why**: stable structure is easier to parse than terminal-friendly text.

- **`--levels <comma-separated>`**: filter by log severity.
    - **What**: only returns/emits events whose `level` is in the list (e.g. `error,warning`).
    - **When**: when you want to focus on signal (errors/warnings) and ignore noisy `log`/`debug` output.
    - **Why**: reduces volume so important events don’t get buried.

- **`--grep <substring>`**: filter by message content.
    - **What**: only returns/emits events whose text contains the given substring.
    - **When**: when you’re hunting for a specific error (“Unhandled”, “ECONNREFUSED”, a request ID, etc.).
    - **Why**: quickly narrows large streams/histories without post-processing.

- **`--since <duration>`**: time window (history).
    - **What**: limits results to events within the last duration (e.g. `10m`, `2h`, `30s`).
    - **When**: when you only care about “recent” history (typically with `logs`).
    - **Why**: avoids dumping an entire backlog when you only need the latest slice.

## Output

- Text output uses 4-character level tags (e.g. `LOG `, `DEBG`, `WARN`, `ERR `, `INFO`, `EXCP`).
- JSON output preserves the raw `level` values.

## Examples

```bash
argus list --json
argus logs app --since 10m --levels error,warning
argus tail app --grep "Unhandled"
```
