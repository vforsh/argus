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

Set a tab's persistent Chrome mute state by attached watcher id or by resolving an existing tab:

```bash
argus ext mute extension
argus ext mute --url localhost
argus ext unmute --tab 123
```

`--tab`, `--url`, and `--title` do not attach the tab. Ambiguous URL/title matches fail closed; use `argus ext tabs` to choose an exact tab id.

When Chrome retains an Argus-owned attachment after extension state is lost, attaching again verifies ownership with a CDP command and reconnects it to rebuild root and iframe sessions. Concurrent attach/detach requests are serialized per tab; failed initialization releases the acquired debugger. Other debuggers are never disconnected by recovery.

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

## Popup will not open / control watcher disappeared

Collect **before** repair or reload:

```bash
argus ext diagnose --out ./argus-incident-1 --json
# Optional CPU/RSS process metadata; no argv, environment, page data or upload:
argus ext diagnose --out ./argus-incident-2 --platform
```

`--out` must name a new directory. The bundle contains a pre-probe journal snapshot, doctor results,
retained native/worker evidence and `timeline.txt`. A missing or unresponsive worker still produces
a bundle. Doctor reads the registry without pruning it and separates PID existence, local HTTP response,
control handshake, debugger attachment and selected-target readiness. Execution remains **not tested**
until recovery explicitly probes it. A successful control check alone says nothing about a tab or iframe.

For a supported attach attempt and an execution check:

```bash
argus ext recover --out ./argus-recovery-1 --tab 123 --watcher app --json
# Verify an existing selected page/iframe without choosing a different target:
argus ext recover --out ./argus-recovery-2 --watcher app --json
```

Recovery saves the incident first, attempts `--tab` attachment when requested, then checks control,
attachment and a bounded `1` evaluation separately. Without `--tab`, it uses the existing selected target;
normal execution recovery may rediscover that target. The CLI cannot reconnect a completely unavailable
worker in a normal Chrome session. If reported, reload Argus in `chrome://extensions`, then repeat doctor
and recovery with a new output directory. Reattach/reselect the intended iframe explicitly after reload.
A successful reload is a recovery observation, not proof that the original failure is fixed.

Before reload, also save the extension's Errors panel and the registration state shown by
`chrome://serviceworker-internals` where available. Chrome does not expose worker registration, process
starvation or an exit reason through the extension API. “No SW”, an inactive worker, a closed stream, or
a delayed retry alone cannot establish a cause. If Chrome was already launched with remote debugging,
`argus chrome version --cdp 127.0.0.1:9222` and Chrome DevTools' ServiceWorker domain can provide extra
manual evidence. Record when DevTools was attached: inspecting a worker can wake it/change its lifetime.
Do not enable debugging on the normal profile merely to claim the missing state is known.

### Evidence and retention

- Extension storage retains at most 128 structured events for seven days across worker restarts and
  extension reloads. Reinstall/removal clears extension storage. Persistence is asynchronous: an abrupt
  stop may lose the last pending writes. The worker mirrors available history to its control host when
  connected; unmirrored events remain unavailable offline until the worker responds again.
- Native evidence lives under `$ARGUS_HOME/incidents` (default `~/.argus/incidents`), independently of
  watcher registry/page-log cleanup. At most 16 host files of about 256 KiB are retained, plus two wrapper
  startup/stderr logs with one 64 KiB rotation each. Shell timestamps have one-second resolution. Re-run `argus ext setup` after upgrading to install
  the instrumented wrappers; an old wrapper cannot report pre-runtime startup failures.
- Journals record boot/session identity, versions, handshake PIDs, retries/backoff, known error categories,
  bundled stack locations and correlated request phases. Retry timer lateness is an event-driven sample,
  **not** an always-running watchdog. No missing timer is interpreted as proof of a hang.
- Native EOF, stderr closure and normal exit are observed facts. A killed host/worker may leave no final
  record; termination cause stays unknown. Wrapper stderr preserves fixed categories, not raw text.
  Raw error messages, URLs (including paths/query/fragment), titles, cookies, credentials, eval payloads,
  page contents and browsing history are omitted from incident exports. Host/session IDs and timestamps
  remain for correlation; files are private and local. Nothing uploads automatically.
- `--platform` collects bounded CPU/RSS, load and memory snapshots on macOS/Linux, plus macOS memory
  pressure or Linux PSI where supported. A point-in-time sample does not establish starvation. Manual Activity Monitor/System Monitor sampling may contain
  sensitive paths and should be reviewed separately before sharing; it is not included automatically.

`npm run test:e2e:extension` includes real Chromium reload, native-host SIGKILL and request-free idle
windows. Unit tests separately simulate unresponsive transports, stale registry, API/storage failures
and startup failure. A skipped Chromium suite is not browser validation; set `ARGUS_E2E_CHROME_BIN`.
