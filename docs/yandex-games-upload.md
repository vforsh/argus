# Yandex Games: Upload Build via Argus

End-to-end workflow for uploading a zip archive to the Yandex Games developer console using Argus CLI.

## Prerequisites

- Argus CLI installed (`npx argus`)
- Chrome launched via Argus with a profile that has an active Yandex session
- The zip file to upload on local disk

## 1. Start Chrome and watcher

```bash
# Start Chrome with a profile that has Yandex cookies
argus chrome start --url "https://games.yandex.ru/console/application/<APP_ID>#application-info-draft" --profile default-full

# Note the CDP port from the output, then start the watcher
argus watcher start --id yandex --url "games.yandex.ru" --chrome-port <CDP_PORT>
```

## 2. Navigate to the Draft tab

The zip upload input only exists on the **"Черновик" (Draft)** tab. If you're on a different tab, the `input#sources<APP_ID>` element won't be in the DOM.

```bash
# Click the Draft tab
argus eval yandex "(function(){ const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Черновик'); b.click(); return 'clicked'; })()"
```

**Gotcha:** The file input is only rendered when the Draft tab is active. Searching for `input[accept='application/zip']` will return 0 matches on other tabs.

## 3. Upload the zip

```bash
argus dom set-file yandex \
  --selector "input#sources<APP_ID>" \
  --file /path/to/build.zip
```

The `dom set-file` command uses CDP's `DOM.setFileInputFiles` which reads the file directly from disk — no need to base64-encode or stream the file contents.

**Gotcha:** If a file was already uploaded previously, the page may show "Файл загружен" (File uploaded) or "Файл проверяется" (File being verified). The file input is still in the DOM and `dom set-file` will replace it. However, if the page has been navigated away and back, you may need to verify the input element is present first:

```bash
argus dom tree yandex --selector "input[accept='application/zip']" --all --json
```

## 4. Save

```bash
argus eval yandex "(function(){ const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Сохранить'); b.click(); return 'clicked'; })()"
```

## 5. Wait for verification

After saving, Yandex runs server-side verification on the uploaded archive. The status shows "Файл проверяется" (File being verified) until complete.

Poll until verification finishes:

```bash
# Reload and check status in a loop
argus eval yandex "document.querySelector('[data-testid=sources]')?.textContent"
```

When complete, the text changes to **"Файл проверен"** (File verified) and "Открыть черновик" (Open draft) links appear.

## 6. Open draft for testing

Click the draft link from the console page — this preserves auth cookies:

```bash
argus dom click yandex --selector "[data-testid=sources] a.g-link:first-of-type"
```

Then attach a watcher to the new tab:

```bash
# Get the target ID of the new tab
curl -s http://127.0.0.1:<CDP_PORT>/json | python3 -c "
import sys,json
for t in json.load(sys.stdin):
    if t['type']=='page' and 'games/app' in t['url']:
        print(t['id'], t['url'])
"

# Attach watcher using the full target ID
argus watcher start --id draft --target <FULL_TARGET_ID> --chrome-port <CDP_PORT>

# Take a screenshot to verify
argus screenshot draft
```

**Gotcha:** The target ID from `/json` must be the **full** ID string (32+ hex chars). Truncated IDs won't match and the watcher will stay detached.

**Gotcha:** Opening the draft URL via `curl -X PUT .../json/new?<url>` (CDP's create-tab API) creates a tab without the `games.yandex.ru` session cookies, resulting in a blank page. Always open draft links by clicking from the console page.

## 7. Submit for moderation (optional)

```bash
argus eval yandex "(function(){ const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Отправить на модерацию'); b.click(); return 'clicked'; })()"
```

## Gotchas summary

| Issue                                         | Cause                                          | Fix                                                             |
| --------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `input#sources<ID>` not found                 | Wrong tab active                               | Navigate to "Черновик" tab first                                |
| `dom set-file` succeeds but no upload happens | File path is relative or doesn't exist         | CLI validates existence; use absolute paths                     |
| Watcher shows `[detached]` or `[unknown]`     | Watcher process crashed or lost CDP connection | Stop and restart the watcher                                    |
| Draft page opens as blank `about:blank`       | Tab opened via CDP API lacks auth cookies      | Click the draft link from the console page instead              |
| Watcher won't attach to new tab               | Target ID was truncated                        | Use the full 32-char hex ID from `/json`                        |
| Ad popup blocks draft game view               | Yandex Advertising overlay                     | `argus dom click draft --selector "button[aria-label='Close']"` |
