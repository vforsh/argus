# argus

CLI for querying local Argus watcher servers.

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

## Options

- `--json` outputs machine-readable JSON (for `tail`, emits newline-delimited JSON events).
- `--levels` accepts comma-separated levels (e.g. `error,warning`).
- `--grep` filters by substring.
- `--since` accepts durations like `10m`, `2h`, `30s`.

## Output

- Text output uses 4-character level tags (e.g. `LOG `, `DEBG`, `WARN`, `ERR `, `INFO`, `EXCP`).
- JSON output preserves the raw `level` values.

## Examples

```bash
argus list --json
argus logs app --since 10m --levels error,warning
argus tail app --grep "Unhandled"
```
