# Cross-Origin Iframe Eval (Extension Mode)

Extension mode can't eval directly in cross-origin iframes. Use postMessage bridge.

## Setup

```bash
# Generate helper
argus iframe-helper --out src/argus-helper.js
argus iframe-helper --iife --out dist/argus-helper.js  # Wrap in IIFE
argus iframe-helper --namespace myapp                   # Custom namespace
```

Include in iframe HTML:

```html
<script src="argus-helper.js"></script>
```

## Usage

```bash
argus eval app "document.title" --iframe "iframe"
argus eval app "window.gameState" --iframe "iframe#game"
argus eval app "heavyComputation()" --iframe "iframe" --iframe-timeout 10000
```

## Message Format

Request (parent → iframe):

```json
{ "type": "argus:eval", "id": "<uuid>", "code": "<expression>" }
```

Response (iframe → parent):

```json
{ "type": "argus:eval-result", "id": "<uuid>", "ok": true, "result": "<value>" }
```

## When to Use

| Scenario                 | Approach                               |
| ------------------------ | -------------------------------------- |
| CDP + any iframe         | `--type iframe` / `--origin` targeting |
| Extension + same-origin  | Eval reaches iframe directly           |
| Extension + cross-origin | **`--iframe` option** (needs helper)   |

## Security

Helper uses `eval()`. Dev/debug builds only. Consider removing from production.

## Limitations

- Requires modifying iframe source
- Results must be serializable
- Async needs explicit `await` in code string
