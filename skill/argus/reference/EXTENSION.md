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

### Limitations

- Debugging bar can't be hidden (Chrome security)
- One debugger per tab
- Tab must stay open
- Manual tab selection (no `--url` matching)
- Cross-origin iframes: use helper script (see [IFRAMES.md](./IFRAMES.md))
