# Argus CDP Bridge Extension

**Repository**: [https://github.com/vforsh/argus](https://github.com/vforsh/argus)

Chrome extension that provides CDP (Chrome DevTools Protocol) access to tabs without requiring Chrome to be launched with `--remote-debugging-port`. Uses the `chrome.debugger` API to attach to tabs and communicates with `argus-watcher` (in extension mode) via Native Messaging.

## Build

```bash
bun run build
```

This bundles the TypeScript source into `dist/`.

To create the installable release archive:

```bash
bun run build
bun run package:release
```

By default this writes `dist/release/argus-extension.zip`.

## Install Extension in Chrome

### From GitHub Release

1. Download `argus-extension-<tag>.zip` from the GitHub release assets
2. Unzip it somewhere stable
3. Open Chrome and navigate to `chrome://extensions`
4. Enable **Developer mode** (toggle in top-right)
5. Click **Load unpacked**
6. Select the unzipped extension directory
7. Note the **Extension ID** shown on the card (you'll need this for the Native Messaging host)

### From Repository Checkout

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `packages/argus-extension` directory
5. Note the **Extension ID** shown on the card (you'll need this for the Native Messaging host)

## Install Native Messaging Host

The extension communicates with `argus-watcher` via Chrome's Native Messaging protocol. You need to install the host manifest:

```bash
# From the argus root directory
bun run build
argus extension setup <EXTENSION_ID>
```

Replace `<EXTENSION_ID>` with the ID shown on the extension card.

This creates:

- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vforsh.argus.bridge.json` and `com.vforsh.argus.control.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.vforsh.argus.bridge.json` and `com.vforsh.argus.control.json`
- **Windows**: Manifest in AppData + registry key (see console output)

## Usage

1. **Install the native host and reload the extension**:

```bash
argus extension setup <EXTENSION_ID>
```

2. **Open Chrome with the extension loaded**. The extension starts an `extension-control` Native Messaging host for browser-level commands such as tab listing, without attaching the debugger to any tab. It also creates a dedicated Native Messaging host + watcher process for each tab you attach.
3. **Attach to tabs**: Run `argus ext attach --tab <tabId>` / `argus ext attach --url <substring>`, or click "Attach" in the extension popup. Every attached tab gets its own watcher id in the local registry.
4. **Connect to a specific iframe (optional)**: Once a tab is attached, the popup shows the top page plus discovered iframe targets for that tab. Selecting an iframe keeps that tab's watcher attached but switches Argus commands (`eval`, `dom *`, selector-based screenshots, etc.) to that frame.
   After a full reload, a remembered iframe selection may take a moment to become executable again. During that window `argus watcher status <id>` reports `targetReady=false`, and frame-scoped commands wait briefly for the iframe to finish rebinding before failing.
   Use the hide/show controls beside iframe targets to keep noisy targets out of the picker. Hidden iframes are remembered per top-level page path and can be restored from the collapsed hidden-targets section.
5. **Use with Argus CLI**:

```bash
  # List watchers
  argus list

  # List browser tabs through the extension-control watcher
  argus ext tabs
  argus ext tabs --url localhost

  # Attach/detach browser tabs through the extension-control watcher
  argus ext attach --url localhost
  argus ext detach --tab 123

  # View logs from a specific attached extension tab watcher
  argus logs extension
  argus logs extension-2

  # Evaluate JavaScript
  argus eval extension-2 "document.title"

  # List extension-backed page/iframe targets
  argus page ls --id extension-2 --tree
```

Run `argus list` to see the `extension-control` watcher plus any attached tab watchers.

## How It Works

```
┌─────────────────────┐     Native Messaging     ┌──────────────────────┐
│  Chrome Extension   │ ◄──────────────────────► │  argus-watcher       │
│  (chrome.debugger)  │      (stdin/stdout)      │  (extension mode)    │
└─────────────────────┘                          └──────────────────────┘
         │                                                │
         │ Attach to tabs                                 │ Watcher API
         ▼                                                ▼
┌─────────────────────┐                          ┌──────────────────────┐
│   Browser Tabs      │                          │  Argus CLI / Client  │
└─────────────────────┘                          └──────────────────────┘
```

1. The extension service worker stays loaded in Chrome and owns the shared `chrome.debugger` lifecycle.
2. On service worker startup, the extension launches a control Native Messaging host for browser-level commands that do not need `chrome.debugger.attach()`.
3. When you click "Attach" in the popup, the extension launches a dedicated Native Messaging host for that tab.
4. Each host starts one `argus-watcher` in `source: 'extension'` mode and announces its own watcher id in the local registry.
5. CDP commands/events for an attached tab flow between the extension and that tab-scoped watcher over Native Messaging.
6. Each tab watcher exposes the standard Argus HTTP API (`/logs`, `/eval`, `/dom/*`, `/targets`, `/attach`, `/detach`, etc.) for its own tab plus that tab's iframe targets.
7. Argus CLI connects to the control watcher for `argus ext tabs`, `argus ext attach`, and `argus ext detach`; it connects to attached tab watchers for page debugging commands.

## Limitations

- **Debugging bar**: Chrome shows "Argus started debugging this browser" bar when attached. This cannot be disabled (security feature).
- **Tab must stay open**: Closing a tab detaches the debugger.
- **One debugger per tab**: Only one extension/DevTools can debug a tab at a time.

## Uninstall

1. Remove extension from `chrome://extensions`
2. Remove Native Messaging host:

```bash
  argus extension remove
```
