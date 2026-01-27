# Troubleshooting

## Chrome binary not found

- Set `ARGUS_CHROME_BIN` to an absolute path to a Chromium-based browser.

## Watcher can’t attach (CDP mode)

- Confirm the CDP endpoint is reachable.
- Ensure `argus watcher start --chrome-port ...` matches the port printed by `argus chrome start`.

Useful probe:

```bash
argus chrome status --host 127.0.0.1 --port 9222
```

## Reload with params fails

- Query param updates are only supported for **http/https** targets (not `chrome://`, `devtools://`, etc.).

## Wrong target matched (iframe / embedded app)

- Use `--type iframe` or `--origin` to avoid matching parent pages that only contain your URL in query params.
- If needed, connect by explicit `--target <targetId>`.

## Extension mode: “Native host has exited”

- Reinstall the host manifest with `argus extension setup <EXTENSION_ID>`.
- Ensure you’re using the same Node version your environment expects.

## Extension mode: can’t connect

- Reload the extension in `chrome://extensions` and try again.

## Extension mode: can’t eval in cross-origin iframe

- Cross-origin iframes need the helper script.
- Generate it via `argus iframe-helper` and include it in the iframe build, then use `argus eval --iframe ...`.
