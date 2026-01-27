# Extension workflow

Use this when you want to debug a normal Chrome session without launching Chrome with CDP flags.

## Contents

- One-time setup
- Attach in Chrome
- Use the CLI
- Limitations

## One-time setup

1. Build the extension:

```bash
cd packages/argus-extension && npm run build
```

2. Load it in Chrome:

- Open `chrome://extensions`
- Enable **Developer mode**
- Click **Load unpacked** → select `packages/argus-extension`
- Copy the **Extension ID** (e.g. `kkoefnlnjlnlbohcifcbkpgmjaokmipi`)

3. Install the Native Messaging host:

```bash
argus extension setup <EXTENSION_ID>
argus extension status
```

## Attach in Chrome

1. Click the Argus extension icon
2. Click **Attach** on the tab you want to debug
3. Chrome shows an orange “debugging” bar (expected; cannot be disabled)

## Use the CLI

The watcher id is typically `extension`.

```bash
argus list
argus logs extension
argus eval extension "document.title"
```

Tip: if `extension` is the only reachable watcher, many commands work without an explicit id (e.g. `argus logs`).

## Limitations

- **Debugging bar**: Chrome shows “Argus is debugging this browser” (security feature).
- **One debugger per tab**: only one extension/DevTools can debug a tab at a time.
- **Tab must stay open**: closing a tab detaches the debugger.
- **Manual selection**: no `--url` matching; select the tab in the extension popup.
- **Cross-origin iframes**: can’t eval directly; use `argus iframe-helper` + `argus eval --iframe ...` (see `EXTENSION_IFRAME_EVAL.md`).
