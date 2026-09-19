# Logs

Console output, uncaught exceptions, and watcher lifecycle messages buffered per watcher (ring buffer, 50k events by default).

```bash
argus logs app                                  # recent events, human format
argus logs app --since 10m --levels error,warning
argus logs app --match "Error|Exception" --ignore-case --match "checkout"   # --match repeats (OR)
argus logs app --source console                 # substring on the event source
argus logs app --limit 50 --json                # bounded JSON preview
argus logs app --json-full                      # full events (can be huge)
argus logs tail app --levels error --json       # long-poll stream (NDJSON); --timeout <ms> per poll
```

Levels: `log`, `info`, `warning`, `error`, `debug`, `exception`. `--match` is a JS regex over the event text; repeated patterns match if any hits. `--ignore-case` (default) / `--case-sensitive` apply to all of them. `--source` is a case-insensitive substring of the event source.

## Cursors And Epochs

`logs cursor` (alias `logs epoch`) returns an opaque position without downloading events. Take it before an action, then read only what followed:

```bash
c=$(argus logs cursor app)
argus click app --selector "#save"
argus logs app --after "$c" --levels error,exception --json
argus logs tail app --after "$c"
```

`--after <cursor>` and `--since-epoch <epoch>` are equivalent readers. Cursors survive page reloads within the same watcher process and fail explicitly (`log_epoch_mismatch`, `log_epoch_evicted`, `log_epoch_invalid`, `log_epoch_future`) after a watcher restart, cross-watcher use, or ring-buffer eviction — take a fresh one.

Navigation commands mint an epoch for you: `goto`, `page back/forward`, and `click`/`keydown --wait-nav` return `epoch` in `--json`, opened just before dispatch so the new page's first log is never missed.

```bash
epoch=$(argus goto app /checkout --json | jq -r .epoch)
argus logs app --since-epoch "$epoch" --levels error,warning
```

Scenario scripts get the same primitives as `ctx.logs.cursor()` / `ctx.logs.read()` / `ctx.logs.session()` ([EVAL.md](./EVAL.md)).

## File Logs

Persisted log files are a Node API feature (`startWatcher({ artifacts: { logs: { enabled: true } } })`, see [start-watcher.ts](../start-watcher.ts)) and land under the artifacts dir (`--artifacts <dir>`, default `$TMPDIR/argus`). The CLI reads the in-memory buffer.
