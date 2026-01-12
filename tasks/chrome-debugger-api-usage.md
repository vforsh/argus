# How Playwriter Extension Uses Chrome Debugger API

## Overview

The Playwriter Chrome extension bridges the **Chrome DevTools Protocol (CDP)** and the **Chrome Extension system** by abusing the `chrome.debugger` API. This allows Playwright to control a user's actual Chrome browser instead of launching headless instances.

## What is `chrome.debugger`?

The `chrome.debugger` API is a Chrome extension API that provides access to the Chrome DevTools Protocol. It's designed for building developer tools and debugging extensions.

### Key Capabilities

| API Method                      | Purpose                   | CDP Equivalent         |
| ------------------------------- | ------------------------- | ---------------------- |
| `chrome.debugger.attach()`      | Connect to a target (tab) | WebSocket connection   |
| `chrome.debugger.detach()`      | Disconnect from target    | WebSocket close        |
| `chrome.debugger.sendCommand()` | Send CDP command          | Send over WebSocket    |
| `chrome.debugger.onEvent`       | Receive CDP events        | Receive over WebSocket |
| `chrome.debugger.onDetach`      | Handle disconnections     | WebSocket close event  |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Playwright                          │
│  chromium.connectOverCDP('ws://localhost:19988/cdp')    │
└──────────────────────────┬───────────────────────────────┘
                           │ WebSocket (CDP protocol)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                  Relay Server (Node.js)                   │
│  - /cdp endpoint: For Playwright clients                │
│  - /extension endpoint: For Chrome extension              │
└──────────────────────────┬───────────────────────────────┘
                           │ WebSocket (custom protocol)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│             Playwriter Extension (background.ts)           │
│  - chrome.debugger.attach() to tabs                     │
│  - chrome.debugger.sendCommand() for CDP                 │
│  - chrome.debugger.onEvent for events                    │
└──────────────────────────┬───────────────────────────────┘
                           │ chrome.debugger API
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      Chrome Browser                        │
│  - Standard CDP implementation under the hood            │
└──────────────────────────────────────────────────────────────┘
```

## Connection Lifecycle

### 1. Initial Debugger Attachment

```typescript
// background.ts:686
async function attachTab(tabId: number): Promise<AttachTabResult> {
	const debuggee = { tabId }

	// Attach to the tab using CDP version 1.3
	await chrome.debugger.attach(debuggee, '1.3')

	// Enable Page domain to get page-level events
	await chrome.debugger.sendCommand(debuggee, 'Page.enable')

	// Get target info to create proper CDP session ID
	const result = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo')

	const targetInfo = result.targetInfo

	// Create a fake sessionId (real CDP sessions use GUIDs)
	const sessionId = `pw-tab-${nextSessionId++}`

	// Store tab state
	store.setState((state) => {
		const newTabs = new Map(state.tabs)
		newTabs.set(tabId, {
			sessionId,
			targetId: targetInfo.targetId,
			state: 'connected',
			attachOrder: nextSessionId,
		})
		return { tabs: newTabs, connectionState: 'connected' }
	})

	return { targetInfo, sessionId }
}
```

### 2. Command Forwarding

When Playwright sends a CDP command:

```typescript
// background.ts:597
async function handleCommand(msg: ExtensionCommandMessage): Promise<any> {
	const { method, params, sessionId } = msg.params

	// Find the tab for this session
	const tab = getTabBySessionId(sessionId)
	if (!tab) {
		throw new Error(`No tab found for sessionId: ${sessionId}`)
	}

	// Create debugger session object
	const debuggerSession = {
		tabId: tab.tabId,
		sessionId: sessionId !== tab.sessionId ? sessionId : undefined,
	}

	// Forward command to Chrome
	return await chrome.debugger.sendCommand(debuggerSession, method, params)
}
```

### 3. Event Forwarding

When Chrome sends a CDP event:

```typescript
// background.ts:600
function onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
	const tab = store.getState().tabs.get(source.tabId)
	if (!tab) return

	// Forward event to relay server
	sendMessage({
		method: 'forwardCDPEvent',
		params: {
			sessionId: source.sessionId || tab.sessionId,
			method,
			params,
		},
	})
}
```

## Session Management

The extension creates **fake CDP session IDs** because `chrome.debugger` doesn't expose actual CDP session IDs.

### Session ID Mapping

```typescript
// background.ts:14-15
let nextSessionId = 1
let childSessions: Map<string, number> = new Map()

// Session format: pw-tab-{number}
const sessionId = `pw-tab-${nextSessionId++}`
```

### Two Types of Sessions

1. **Main Tab Sessions** (`pw-tab-1`, `pw-tab-2`, ...)
    - Created when extension attaches to a tab
    - Tracked in `store.getState().tabs`

2. **Child Target Sessions** (iframes, workers, etc.)
    - Created automatically by Chrome
    - Mapped to parent tab via `childSessions` Map
    - Handled via `Target.attachedToTarget` events

```typescript
// background.ts:606-609
if (method === 'Target.attachedToTarget' && params?.sessionId) {
	// Track which tab owns this child session
	childSessions.set(params.sessionId, source.tabId!)
}
```

## Special Command Handling

Some CDP commands require special handling because `chrome.debugger` limitations.

### 1. Target.createTarget → chrome.tabs.create()

```typescript
// background.ts:563-572
case 'Target.createTarget': {
  const url = msg.params.params?.url || 'about:blank'

  // Create a real Chrome tab
  const tab = await chrome.tabs.create({ url, active: false })

  // Attach debugger to new tab
  await sleep(100) // Wait for tab to load
  const { targetInfo } = await attachTab(tab.id)

  // Return CDP-compatible response
  return { targetId: targetInfo.targetId }
}
```

### 2. Target.closeTarget → chrome.tabs.remove()

```typescript
// background.ts:574-581
case 'Target.closeTarget': {
  const targetTab = getTabByTargetId(msg.params.params?.targetId)
  if (!targetTab) {
    return { success: false }
  }

  // Close the actual Chrome tab
  await chrome.tabs.remove(targetTab.tabId)

  return { success: true }
}
```

### 3. Runtime.enable → Disable/Enable Trick

```typescript
// background.ts:544-561
case 'Runtime.enable': {
  // Chrome doesn't re-send executionContextCreated events
  // when multiple clients call Runtime.enable on same tab.
  // Workaround: disable first to force Chrome to resend events.

  try {
    await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
    await sleep(50)
  } catch (e) {
    logger.debug('Error disabling Runtime (ignoring):', e)
  }

  return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', msg.params.params)
}
```

**Why this is needed:**

- Playwright waits for `Runtime.executionContextCreated` events
- Chrome only sends these the FIRST time Runtime.enable is called
- Subsequent enable calls don't trigger events
- By disabling first, we force Chrome to treat this as a "fresh" enable

## CDP Event Forwarding

The extension forwards most CDP events, but some require special handling.

### Standard Event Forwarding

```typescript
// background.ts:626-633
sendMessage({
	method: 'forwardCDPEvent',
	params: {
		sessionId: source.sessionId || tab.sessionId,
		method,
		params,
	},
})
```

### Special Event Handling

#### Target.attachedToTarget

```typescript
// background.ts:606-609
if (method === 'Target.attachedToTarget' && params?.sessionId) {
	logger.debug('Child target attached:', params.sessionId, 'for tab:', source.tabId)
	childSessions.set(params.sessionId, source.tabId!)
}
```

#### Target.detachedFromTarget

```typescript
// background.ts:611-624
if (method === 'Target.detachedFromTarget' && params?.sessionId) {
	const mainTab = getTabBySessionId(params.sessionId)
	if (mainTab) {
		// Main tab detached - remove from state
		store.setState((state) => {
			const newTabs = new Map(state.tabs)
			newTabs.delete(mainTab.tabId)
			return { tabs: newTabs }
		})
	} else {
		// Child target detached - clean up mapping
		childSessions.delete(params.sessionId)
	}
}
```

## Detach Handling

When debugger detaches (user clicks "End debugging" bar):

```typescript
// background.ts:636-673
function onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
	const tabId = source.tabId

	// Forward detach event to Playwright
	const tab = store.getState().tabs.get(tabId)
	if (tab) {
		sendMessage({
			method: 'forwardCDPEvent',
			params: {
				method: 'Target.detachedFromTarget',
				params: { sessionId: tab.sessionId, targetId: tab.targetId },
			},
		})
	}

	// Clean up child sessions
	for (const [childSessionId, parentTabId] of childSessions.entries()) {
		if (parentTabId === tabId) {
			childSessions.delete(childSessionId)
		}
	}

	// Remove from state
	store.setState((state) => {
		const newTabs = new Map(state.tabs)
		newTabs.delete(tabId)
		return { tabs: newTabs }
	})
}
```

## Limitations of chrome.debugger API

### 1. No Native WebSocket Support

`chrome.debugger` doesn't expose WebSocket endpoints. That's why we need:

- Extension as WebSocket **client** to relay server
- Relay server as WebSocket **server** for Playwright

### 2. No Real CDP Session IDs

Chrome doesn't expose actual CDP session GUIDs to extensions. We fake them:

```typescript
const sessionId = `pw-tab-${nextSessionId++}` // pw-tab-1, pw-tab-2, etc.
```

### 3. Restricted Pages

Some pages cannot be debugged:

- `chrome://` URLs
- `chrome-extension://` URLs
- Web Store pages

```typescript
// background.ts:895-899
function isRestrictedUrl(url: string | undefined): boolean {
	const restrictedPrefixes = ['chrome://', 'chrome-extension://', 'devtools://', 'edge://', 'https://chrome.google.com/']
	return restrictedPrefixes.some((prefix) => url?.startsWith(prefix))
}
```

### 4. No Direct Target Creation

Chrome doesn't expose all CDP commands. We work around by using Chrome APIs:

- `Target.createTarget` → `chrome.tabs.create()`
- `Target.closeTarget` → `chrome.tabs.remove()`

### 5. Event Delivery Differences

Chrome's `chrome.debugger` behaves differently than raw CDP WebSocket:

- Multiple enable calls don't resend events (need disable/enable trick)
- Event timing may differ from WebSocket implementation

## Security Considerations

### Origin Validation (Relay Server)

The relay server validates extension origin to prevent malicious connections:

```typescript
// cdp-relay.ts:677-686
const origin = c.req.header('origin')
if (!origin || !origin.startsWith('chrome-extension://')) {
	return c.text('Forbidden', 403)
}

const extensionId = origin.replace('chrome-extension://', '')
if (!ALLOWED_EXTENSION_IDS.includes(extensionId)) {
	return c.text('Forbidden', 403)
}
```

### Localhost Only

Extension endpoint only accepts connections from localhost:

```typescript
// cdp-relay.ts:664-671
const info = getConnInfo(c)
const remoteAddress = info.remote.address
const isLocalhost = remoteAddress === '127.0.0.1' || remoteAddress === '::1'

if (!isLocalhost) {
	return c.text('Forbidden - Extension must be local', 403)
}
```

## Advantages Over Headless Chrome

### 1. Real User Context

- Uses actual Chrome profile, cookies, extensions
- Maintains authentication state
- Renders with user's screen settings

### 2. No Resource Isolation

- Shares DevTools, performance tools
- Can debug extension behavior
- Access to all user browser state

### 3. Better Testing of Real Browsers

- Tests with actual Chrome renderer
- Same GPU acceleration as user
- Same network conditions

## Files Involved

| File                          | Purpose                              |
| ----------------------------- | ------------------------------------ |
| `extension/src/background.ts` | Main debugger API usage              |
| `extension/src/types.ts`      | TypeScript types for extension state |
| `playwriter/src/cdp-relay.ts` | WebSocket relay server               |
| `playwriter/src/protocol.ts`  | Custom extension-relay protocol      |

## Further Reading

- [Chrome Debugger API Docs](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Playwright CDP Connection Flow](./docs/playwright-cdp-connection.md)
