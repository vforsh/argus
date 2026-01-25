# Argus CDP Bridge Extension

Chrome extension that provides CDP (Chrome DevTools Protocol) access to tabs without requiring Chrome to be launched with `--remote-debugging-port`. Uses the `chrome.debugger` API to attach to tabs and communicates with `argus-bridge` via Native Messaging.

## Build

```bash
npm run build
```

This bundles the TypeScript source into `dist/`.

## Install Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `packages/argus-extension` directory
5. Note the **Extension ID** shown on the card (you'll need this for the Native Messaging host)

## Install Native Messaging Host

The extension communicates with `argus-bridge` via Chrome's Native Messaging protocol. You need to install the host manifest:

```bash
# From the argus root directory
cd packages/argus-bridge
npm run build
node dist/scripts/install-host.js install <EXTENSION_ID>
```

Replace `<EXTENSION_ID>` with the ID from step 5 above.

This creates:

- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vforsh.argus.bridge.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.vforsh.argus.bridge.json`
- **Windows**: Manifest in AppData + registry key (see console output)

## Usage

1. **Start the bridge**:

    ```bash
    npx argus-bridge start --id my-bridge --port 9333
    ```

2. **Attach to tabs**: Click the Argus extension icon in Chrome toolbar, then click "Attach" on the tabs you want to monitor.

3. **Use with Argus CLI**:

    ```bash
    # View logs from attached tab
    argus logs --watcher http://127.0.0.1:9333

    # Evaluate JavaScript
    argus eval "document.title" --watcher http://127.0.0.1:9333
    ```

## How It Works

```
┌─────────────────────┐     Native Messaging     ┌──────────────────────┐
│  Chrome Extension   │ ◄──────────────────────► │  argus-bridge        │
│  (chrome.debugger)  │      (stdin/stdout)      │  (HTTP server)       │
└─────────────────────┘                          └──────────────────────┘
         │                                                │
         │ Attach to tabs                                │ Watcher API
         ▼                                               ▼
┌─────────────────────┐                          ┌──────────────────────┐
│   Browser Tabs      │                          │  Argus CLI / Client  │
└─────────────────────┘                          └──────────────────────┘
```

1. Extension uses `chrome.debugger.attach()` to connect to tabs
2. CDP commands/events flow through Native Messaging to `argus-bridge`
3. Bridge exposes standard Argus HTTP API (`/logs`, `/eval`, `/dom/*`, etc.)
4. Argus CLI connects to bridge just like a regular watcher

## Limitations

- **Orange debugging bar**: Chrome shows "Argus is debugging this browser" bar when attached. This cannot be disabled (security feature).
- **Tab must stay open**: Closing a tab detaches the debugger.
- **One debugger per tab**: Only one extension/DevTools can debug a tab at a time.

## Uninstall

1. Remove extension from `chrome://extensions`
2. Remove Native Messaging host:
    ```bash
    node packages/argus-bridge/dist/scripts/install-host.js uninstall
    ```
