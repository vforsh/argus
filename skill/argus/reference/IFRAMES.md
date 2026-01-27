# Iframes and Target Selection (CDP)

For embedded apps/games in iframes. Simple `--url` matching can attach to wrong target when parent page has iframe URL in query string.

## Targeting Flags

```bash
# Only iframes
argus watcher start --id game --type iframe --url localhost:3007

# Match by origin (ignores query params)
argus watcher start --id game --origin https://localhost:3007

# Explicit target ID
argus page targets --type iframe
argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344

# Match parent URL pattern
argus watcher start --id game --type iframe --parent yandex.ru --url localhost:3007
```

## Discovering Targets

```bash
argus page targets              # List all
argus page targets --tree       # Parent-child tree
argus page targets --type iframe
```

## Example (embedded game)

```bash
# Terminal 1
argus chrome start --url "https://yandex.ru/games/app/123"

# Terminal 2
argus watcher start --id game --type iframe --url localhost:3007

# Terminal 3
argus logs game --levels error,warning
argus eval game "window.gameState"
```

## Extension Mode

Cross-origin iframes need helper script + `argus eval --iframe`. See [EXTENSION_IFRAME_EVAL.md](./EXTENSION_IFRAME_EVAL.md).
