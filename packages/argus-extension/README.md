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

Replace `<EXTENSION_ID>` with the ID from step 5 above.

This creates:

- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vforsh.argus.bridge.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.vforsh.argus.bridge.json`
- **Windows**: Manifest in AppData + registry key (see console output)

## Usage

1. **Install the native host and reload the extension**:

```bash
argus extension setup <EXTENSION_ID>
```

2. **Open Chrome with the extension loaded**. The extension service worker connects to the native host automatically, and that native host starts an extension-backed watcher process.
3. **Attach to tabs**: Click the Argus extension icon in Chrome toolbar, then click "Attach" on the tabs you want to monitor.
4. **Connect to a specific iframe (optional)**: Once a tab is attached, the popup shows the top page plus discovered iframe targets. Selecting an iframe keeps the debugger attached to the tab but switches Argus commands (`eval`, `dom *`, selector-based screenshots, etc.) to that frame.
5. **Use with Argus CLI**:

```bash
  # List watchers
  argus list

  # View logs from the extension-backed watcher
  # The default watcher id is usually "extension"
  argus logs extension

  # Evaluate JavaScript
  argus eval extension "document.title"

  # List extension-backed page/iframe targets
  argus page ls --id extension --tree
```

If `extension` is already taken or stale, run `argus list` and use the watcher id shown there.

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

1. The extension service worker connects to the Native Messaging host on startup.
2. Chrome launches `argus watcher native-host`, which starts `argus-watcher` in `source: 'extension'` mode and announces it in the local watcher registry.
3. When you click "Attach" in the popup, the extension uses `chrome.debugger.attach()` to connect to the selected tab.
4. CDP commands/events flow between the extension and watcher over Native Messaging.
5. The watcher exposes the standard Argus HTTP API (`/logs`, `/eval`, `/dom/*`, `/targets`, `/attach`, `/detach`, etc.).
6. Argus CLI connects to that watcher just like CDP mode.

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
