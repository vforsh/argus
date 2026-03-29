# argus dialog

Inspect and handle browser JavaScript dialogs on the watcher-attached page.

## Syntax

```bash
argus dialog status [id] [--json]
argus dialog accept [id] [--json]
argus dialog dismiss [id] [--json]
argus dialog prompt [id] --text "<value>" [--json]
```

## Examples

```bash
argus dialog status app
argus dialog accept app
argus dialog dismiss app
argus dialog prompt app --text "hello"
argus dialog status app --json
```

## Behavior

- `status` returns the single active dialog, or `null` when nothing is open.
- `accept` resolves the active dialog with OK / Leave / equivalent browser action.
- `dismiss` resolves the active dialog with Cancel / Stay / equivalent browser action.
- `prompt` is just `accept` plus submitted text. It fails if the active dialog is not a prompt.

Chrome only exposes one active JavaScript dialog at a time, so Argus models dialog state as a single current snapshot instead of a list.
