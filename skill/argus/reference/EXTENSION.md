## Extension Workflow

Debug normal Chrome session without CDP flags.

### One-Time Setup

```bash
# 1) Build extension
cd packages/argus-extension && npm run build

# 2) Load in Chrome
#    chrome://extensions → Developer mode → Load unpacked → select packages/argus-extension
#    Copy Extension ID (e.g. kkoefnlnjlnlbohcifcbkpgmjaokmipi)

# 3) Install native host
argus extension setup <EXTENSION_ID>
argus extension status
```

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
