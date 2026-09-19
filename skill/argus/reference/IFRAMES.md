# Iframes

Three ways to reach code inside an iframe. Pick by mode.

| Situation                       | Approach                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| CDP, any iframe                 | Attach the watcher to the iframe target (`--type iframe`, …)                              |
| Extension, any iframe           | `ext use --iframe-url …` / `ext select` ([EXTENSION.md](./EXTENSION.md#iframe-selection)) |
| Extension, cross-origin, legacy | postMessage helper + `eval --iframe <selector>`                                           |

## CDP: attach to the iframe target

Plain `--url` can match the _host_ page when it carries the iframe URL in its query string. Narrow it:

```bash
argus page ls --tree                          # discover targets (alias: page targets); --type iframe
argus watcher start --id game --type iframe --url localhost:3007
argus watcher start --id game --origin https://localhost:3007          # ignores query params
argus watcher start --id game --type iframe --parent yandex.ru --url localhost:3007
argus watcher start --id game --target CC1135709D9AC3B9CC0446F8B58CC344  # exact id
argus start --id game --url "https://yandex.ru/games/app/123" --type iframe --origin https://localhost:3007
```

The watcher then treats the iframe as its page: `logs game`, `eval game "window.gameState"`, `screenshot game` all run in-frame. Reload still reloads the top tab.

## Extension: select the iframe

```bash
argus ext use --url portal.example --as app --iframe-url game.example
argus ext select app --iframe-title "Game Title" | --iframe auto | --page
argus ext targets app --tree
```

Selection is per watcher and survives reloads; a missing frame fails `extension_frame_not_ready` rather than running on the host. Network needs `--scope selected` to see iframe traffic.

## Legacy: postMessage helper (`eval --iframe`)

Only when the iframe cannot be selected as a target. Requires modifying the iframe's source.

```bash
argus eval iframe-helper --out src/argus-helper.js           # --iife, --no-log, --namespace myapp
argus eval app "window.gameState" --iframe "iframe#game"
argus eval app "heavy()" --iframe "iframe" --iframe-timeout 10s --iframe-namespace myapp
```

Include `<script src="argus-helper.js"></script>` in the iframe HTML. Wire format: parent sends `{ type: "argus:eval", id, code }`, iframe answers `{ type: "argus:eval-result", id, ok, result }`. The helper uses `eval()` — dev builds only. Results must be serializable; async code needs an explicit `await`. Scenario modules (`--file` with default export) do not combine with `--iframe`; select the iframe as the target instead.
