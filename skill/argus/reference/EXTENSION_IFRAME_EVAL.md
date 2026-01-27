# Cross-Origin Iframe Eval in Extension Mode

When using Argus in **extension mode**, evaluating JavaScript in cross-origin iframes requires a different approach than CDP mode. Due to browser security restrictions, the Chrome extension cannot directly execute code in cross-origin iframe contexts.

## The Problem

In CDP mode, you can target iframes directly using `--type iframe` or `--origin`. However, in extension mode:

- The debugger attaches to the **top-level page** only
- Cross-origin iframes have separate security contexts
- Direct `eval` calls cannot reach into cross-origin frames

## Solution: postMessage Bridge

The workaround is to include a small helper script in your iframe that listens for eval requests via `postMessage` and returns results the same way.

### Step 1: Generate the Helper Script

```bash
# Output to stdout (copy/paste or pipe)
argus iframe-helper

# Save directly to a file
argus iframe-helper --out src/argus-helper.js

# Wrap in IIFE (avoids polluting global scope)
argus iframe-helper --iife --out dist/argus-helper.js

# Omit the console.log confirmation message
argus iframe-helper --no-log

# Use a custom namespace (changes message types)
argus iframe-helper --namespace myapp
```

### Step 2: Include in Your Iframe

Add the generated script to your iframe's HTML:

```html
<!-- In your iframe's index.html -->
<script src="argus-helper.js"></script>
```

Or inline it directly:

```html
<script>
	// Paste the output of `argus iframe-helper` here
</script>
```

### Step 3: Eval from Parent via postMessage

From the parent page (which Argus is attached to), send eval requests:

```javascript
// Generate a unique ID for this request
const id = crypto.randomUUID()

// Send the eval request to the iframe
const iframe = document.querySelector('iframe')
iframe.contentWindow.postMessage(
	{
		type: 'argus:eval',
		id,
		code: 'document.title',
	},
	'*',
)

// Listen for the response
window.addEventListener('message', (event) => {
	if (event.data?.type === 'argus:eval-result' && event.data.id === id) {
		if (event.data.ok) {
			console.log('Result:', event.data.result)
		} else {
			console.error('Error:', event.data.error)
		}
	}
})
```

### Using with Argus eval

Use the `--iframe` option to automatically wrap your expression in the postMessage boilerplate:

```bash
# Eval in iframe using CSS selector
argus eval app "document.title" --iframe "iframe"

# With specific selector
argus eval app "window.gameState" --iframe "iframe#game"

# Custom timeout (default: 5000ms)
argus eval app "heavyComputation()" --iframe "iframe" --iframe-timeout 10000

# Custom namespace (must match helper script)
argus eval app "location.href" --iframe "iframe" --iframe-namespace myapp
```

The `--iframe` option:

- Finds the iframe using the provided CSS selector
- Sends the expression via postMessage to the helper script
- Waits for the response and returns the result
- Throws if the iframe isn't found or the eval times out

This is equivalent to manually writing the postMessage boilerplate, but much simpler.

## Message Format

### Request (parent → iframe)

```typescript
{
  type: 'argus:eval',      // or 'myapp:eval' with --namespace myapp
  id: string,              // unique request ID
  code: string             // JavaScript code to evaluate
}
```

### Response (iframe → parent)

```typescript
{
  type: 'argus:eval-result',  // or 'myapp:eval-result' with --namespace myapp
  id: string,                 // matching request ID
  ok: boolean,                // true if eval succeeded
  result?: any,               // eval result (if ok)
  error?: string              // error message (if !ok)
}
```

## Custom Namespace

If `argus:eval` conflicts with your app's message types, use a custom namespace:

```bash
argus iframe-helper --namespace myapp
```

This changes the message types to `myapp:eval` and `myapp:eval-result`.

## Security Considerations

- The helper script uses `eval()`, which executes arbitrary code. Only include it in development/debug builds.
- The script listens for messages from `*` (any origin). In production, you may want to restrict this.
- Consider removing the helper script from production builds entirely.

## When to Use This

| Scenario                             | Recommended Approach                               |
| ------------------------------------ | -------------------------------------------------- |
| CDP mode + same-origin iframe        | Use `--type iframe` targeting                      |
| CDP mode + cross-origin iframe       | Use `--type iframe` + `--origin`                   |
| Extension mode + same-origin iframe  | Eval from parent reaches iframe                    |
| Extension mode + cross-origin iframe | **Use `--iframe` option** (requires helper script) |

## Quick Start

```bash
# 1. Generate and include helper script in your iframe (one-time)
argus iframe-helper --out src/argus-helper.js

# 2. Eval in the iframe
argus eval app "document.title" --iframe "iframe"
argus eval app "window.gameState" --iframe "iframe#game"
```

## Limitations

- Requires modifying the iframe's source code to include the helper
- Results must be serializable (no DOM nodes, functions, etc.)
- Async operations need explicit `await` in the code string
- The iframe must be loaded and the helper script must be running
