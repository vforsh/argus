## Extension Workflow

Debug normal Chrome session without CDP flags.

### One-Time Setup

```bash
# Installs native hosts, opens chrome://extensions, waits for the extension to connect:
argus extension install
#   → click "Load unpacked" and select the printed folder (enable Developer mode if hidden)
```

The extension ID is **pinned** (via a `key` in the manifest), so there's no ID to copy/paste and the prebuilt extension ships with the CLI — no build step. Useful sub-commands:

```bash
argus extension path      # absolute folder to "Load unpacked"
argus extension status    # native host config + extension ID
argus extension install --no-wait   # scripted/non-interactive (skip the connect wait)
```

Advanced: `argus extension setup [extensionId]` installs only the native hosts (pass an id to override the pinned one for a differently-keyed build).

> Migration: if you previously loaded an unkeyed build, reload the extension once at `chrome://extensions` so it picks up the pinned ID.

### Usage

1. Click Argus extension icon
2. Click **Attach** on target tab
3. Chrome shows orange "debugging" bar (expected)

```bash
argus list
argus logs extension
argus eval extension "document.title"
```

Attachment failures surface Chrome's original error in both popup and CLI; no successful attachment is reported and the failed tab bridge is removed. A connected control bridge does not mean a tab is attached: `argus ext doctor --watcher <id>` flags detached, disconnected, or pending selected targets.

### Iframe Recovery

`argus reload <id>` reloads the whole tab. A requested iframe remains selected while missing or booting; eval, DOM, and capture wait up to 3s for readiness, then fail with `extension_frame_not_ready`. They never fall back to the host page. Recovery requires a unique URL/hint match; `ext targets <id> --tree` keeps a `pending` placeholder visible (`attached: true` denotes selection, `targetReady: false` denotes pending readiness in JSON).

Retry once the iframe loads, or explicitly select the host with `argus ext select <id> --page`. Use `argus ext doctor --watcher <id>` to distinguish target readiness from bridge health.

### Limitations

- Debugging bar can't be hidden (Chrome security)
- One debugger per tab
- Tab must stay open
- Manual tab selection (no `--url` matching)
- Cross-origin iframes: use helper script (see [IFRAMES.md](./IFRAMES.md))
