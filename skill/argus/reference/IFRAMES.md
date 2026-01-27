# Iframes and target selection (CDP mode)

When your app runs inside an iframe (embedded games/widgets), you often need more precise targeting than “URL contains X”.

## Contents

- Why simple URL matching fails
- Targeting flags (`--type`, `--origin`, `--target`, `--parent`)
- Discovering targets
- Example workflow

## Why simple URL matching fails

Simple `--url localhost:3007` can attach to the wrong target when:

- The parent page includes the iframe URL in a query string (e.g. `?game_url=https://localhost:3007`)
- Multiple targets share similar URLs

## Targeting flags

Use these with `argus watcher start` to narrow the match.

Only match iframe targets:

```bash
argus watcher start --id game --type iframe --url localhost:3007
```

Match by origin (ignores query params in other pages):

```bash
argus watcher start --id game --origin https://localhost:3007
```

Attach to a specific target id:

```bash
# list targets first
argus page targets --type iframe

# then connect directly
argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344
```

Match only if the parent URL contains a pattern:

```bash
argus watcher start --id game --type iframe --parent yandex.ru --url localhost:3007
```

## Discovering targets

List targets (includes type/parent info):

```bash
argus page targets
```

Show parent-child relationships:

```bash
argus page targets --tree
```

Filter to iframes:

```bash
argus page targets --type iframe
```

## Example workflow (embedded game)

```bash
# Terminal 1: start Chrome
argus chrome start --url "https://yandex.ru/games/app/123"

# Terminal 2: start watcher for iframe
argus watcher start --id game --type iframe --url localhost:3007

# Terminal 3: debug
argus logs game --levels error,warning
argus eval game "window.gameState"
argus screenshot game --out game.png
```

## Extension mode note

In **extension mode**, cross-origin iframe eval cannot be done by selecting an iframe target directly. Use the helper script + `argus eval --iframe ...` workflow described in `EXTENSION_IFRAME_EVAL.md`.
