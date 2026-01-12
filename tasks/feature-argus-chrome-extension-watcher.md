# Goal

Use Argus via a Chrome extension (like Playwriter does), while keeping the **existing Argus model** (`argus list/logs/tail`) and **not requiring a separate relay server**.

- Extension (“watcher”) uses `chrome.debugger` to subscribe to console events on real user tabs.
- A **Native Messaging host process** (spawned by Chrome on demand) receives log events from the extension, buffers them, and exposes the **existing Argus watcher HTTP API** so the existing CLI works unchanged.

Non-goals (v1):

- No `eval`, `net/*`, `trace/*`, `screenshot`, `dom/*` (logs only).
- No remote/container support (local machine only).
- No Web Store packaging/publish hardening (unpacked dev extension is fine).

---

# Current state

Argus today is “Node watcher processes + registry + CLI”:

- `@vforsh/argus-watcher` starts a watcher process that:
    - Connects to Chrome over CDP (remote debugging port).
    - Buffers logs.
    - Serves an HTTP API on `127.0.0.1` (`/status`, `/logs`, `/tail`, …).
    - Announces itself in `~/.argus/registry.json` via `announceWatcher()` + heartbeat.
- `@vforsh/argus` (CLI) discovers watchers from registry and queries them over HTTP:
    - `/status` to show reachability + metadata
    - `/logs` and `/tail` to read buffered log events

Key types/seams:

- Watcher discovery identity is `WatcherRecord` (host/port/id/pid/etc) (`packages/argus-core/src/registry/types.ts`).
- Log payload is `LogEvent` (`packages/argus-core/src/protocol/logs.ts`): `{ id, ts, level, text, args, file, line, column, pageUrl, pageTitle, source }`.

---

# Proposed design

## High-level architecture

We add two new components:

1. **Chrome extension (MV3)**: “Argus Extension Watcher”

- On a tab, user can **manually enable** watching (explicit consent).
- Extension also supports **auto-enable by match rules** (URL/title match).
- When enabled, extension uses `chrome.debugger.attach()` and:
    - `Runtime.enable`
    - subscribes to `Runtime.consoleAPICalled`
    - optionally `Runtime.exceptionThrown` (map to `level: 'exception'`) if we decide “logs only” includes exceptions; if not, skip in v1.
- Extension forwards normalized log events to the native host (below).

2. **Native Messaging host (Node process)**: “argus-extension-host”

- Started by Chrome via `chrome.runtime.connectNative()` (no TCP relay server required).
- Receives messages from the extension over stdin/stdout (JSON).
- For each enabled tab, host creates a local **Argus watcher instance** with:
    - In-memory `LogBuffer`
    - Minimal HTTP server implementing **only**:
        - `GET /status`
        - `GET /logs`
        - `GET /tail`
    - Registry announcement + heartbeat so it shows up in `argus list`.
- CLI remains unchanged: it talks HTTP to the host’s per-tab watchers like normal.

Why this satisfies “no relay server”:

- There is **no shared WebSocket/TCP relay** (like Playwriter’s `:19988`).
- The only “server” that exists is the Argus watcher HTTP endpoint itself, created and owned by the native host process and scoped to the local machine—this preserves the existing Argus CLI contract.

## Watcher identity / IDs (one per tab)

We need stable-ish watcher IDs for `argus logs <id>`:

- v1 (recommended): `ext-tab-<tabId>` (e.g. `ext-tab-123`).
    - Pros: trivial; no extra UI.
    - Cons: tab IDs change between Chrome restarts; IDs are not long-term stable.

Optional follow-up: allow per-tab “alias” stored in extension storage (and surfaced in popup), so watcher id becomes `ext-<alias>` and remains stable.

## Auto-enable matching + manual consent

User asked for both **a and b** (“manual + match”):

- **Manual always wins**:
    - If user explicitly enabled a tab, keep it enabled until user disables.
    - If user explicitly disabled, do not re-enable it via matcher.
- **Auto-enable**:
    - Extension periodically scans tabs and enables those whose URL/title match configured patterns.
    - Matching rules are stored in extension storage (for v1: simple substring match; optionally regex later).

Guard clauses: every enable/attach path should early-return on restricted URLs and already-enabled tabs.

## Message protocol: extension ⇄ native host

Define a small JSON message protocol (line-delimited JSON is simplest):

Extension → Host:

- `hello` `{ type: 'hello', extensionVersion, chromeVersion? }`
- `tab.enable` `{ type: 'tab.enable', tabId, watcherId, url, title }`
- `tab.disable` `{ type: 'tab.disable', tabId, watcherId }`
- `log` `{ type: 'log', tabId, watcherId, event: LogEventLike }`
- `tab.meta` `{ type: 'tab.meta', tabId, watcherId, url?, title? }` (optional, for updates)
- `ping` (optional, keepalive)

Host → Extension:

- `ack` / `error`
- `config` `{ type: 'config', autoEnable: { enabled, match: { urlContains?, titleContains? } } }` (optional if we want host-driven config; otherwise config stays in extension only)

`LogEventLike` mapping:

- `ts`: extension supplies `Date.now()`.
- `level`: map from `Runtime.consoleAPICalled.type`:
    - `log|debug|info|warning|error` → same
    - `assert` → `error` (or `warning`; pick one and document)
- `text`: construct from args best-effort:
    - Prefer `RemoteObject.value` when present for primitives
    - Else fall back to `description` / `unserializableValue` / `type`
    - Join args with spaces (like console)
- `args`: for v1, send a compact “preview-ish” structure only (avoid huge payloads)
- `file/line/column`: best-effort from `stackTrace` frames when present; else null
- `pageUrl/pageTitle`: from tab meta
- `source`: `'console'`

## MV3 lifecycle / keepalive (important risk)

Chrome MV3 service workers can be suspended, which will:

- drop the native messaging port
- cause the host process to exit
- remove watchers from registry as heartbeat stops

For v1 (unpacked dev), implement a basic keepalive:

- Use an **offscreen document** (MV3 feature) to keep the extension alive while enabled tabs exist.
- Or, if offscreen is too much for v1, explicitly accept that watchers exist only while the extension is “awake” (document this clearly).

Recommended: offscreen doc, because otherwise `argus tail` will be flaky.

---

# Touch points (file-by-file)

## New: extension (not an npm workspace package)

Add `extension/` at repo root:

- `extension/manifest.json` (MV3)
- `extension/src/background.ts`
    - attach/detach logic
    - `chrome.debugger.onEvent` handler
    - native messaging connection management
    - auto-enable matcher loop (optional)
- `extension/src/popup.tsx` (or plain TS/HTML) + `popup.html`
    - enable/disable current tab
    - show current watcher id
    - configure match rules (minimal)
- `extension/src/offscreen.ts` (if using offscreen keepalive)

Build:

- Keep it simple for v1: `esbuild` or `tsup` invoked from root scripts.

## New: native host package (workspace)

Add `packages/argus-extension-host/` (npm workspace):

- `src/nativeHost.ts`
    - stdin line reader
    - message router with guard clauses
    - lifecycle: create/remove per-tab watchers
- `src/tabWatcher.ts`
    - owns a `LogBuffer`, watcher `WatcherRecord`, heartbeat, and HTTP server handle
    - exposes `addLogEvent(event)`; updates `updatedAt`
- `src/http/server.ts`
    - minimal `GET /status`, `GET /logs`, `GET /tail`
    - reuse `@vforsh/argus-core` response types
    - (optionally import `compileMatchPatterns` helpers from `@vforsh/argus-watcher` if we want `--match` filtering parity; otherwise implement minimal filtering in v1)
- `src/index.ts`
    - exports start function for programmatic use (optional; if exported, add JSDoc)

## New: dev install helper

Add a script to install the native host manifest (macOS-focused, dev-only):

- `scripts/extension/install-native-host.ts`
    - Writes `com.vforsh.argus.json` to the Chrome NativeMessagingHosts directory
    - Points to the built host entrypoint (node + absolute path) or a tiny shim script in `packages/argus-extension-host/dist/…`
    - Includes allowed extension ID(s) (for unpacked extension, this is stable per machine profile; document how to get it)

Root `package.json` scripts:

- `build:argus-extension-host`
- `dev:extension` (build/watch extension)
- `install:native-host` (runs the installer script)

---

# Rollout order

1. **Native host MVP** (no extension yet)
    - Implement `tabWatcher` + minimal HTTP server + registry heartbeat.
    - Add a small CLI/dev harness that simulates `tab.enable` + `log` messages so we can validate `argus list/logs/tail` end-to-end.

2. **Extension MVP** (manual enable only)
    - Implement popup “Enable on this tab”.
    - On enable, attach via `chrome.debugger`, subscribe to console events, forward to host.
    - Verify `argus tail ext-tab-<id>` shows events live.

3. **Auto-enable by match rules**
    - Store match settings in extension storage.
    - Periodically scan tabs and enable those that match (respect manual disable).

4. **Keepalive**
    - Add offscreen doc to keep native messaging connection alive while any enabled tabs exist.
    - Document behavior and troubleshooting.

---

# Risks / edge cases

- **MV3 suspension**: without keepalive, watchers will randomly disappear. Offscreen doc mitigates.
- **Restricted URLs**: `chrome://`, `chrome-extension://`, Web Store pages can’t be debugged; must guard early and show a clear error in popup.
- **High-volume logs**: host must bound memory; reuse `LogBuffer` behavior (drop old entries).
- **Event payload size**: CDP remote objects can be huge; v1 should keep `args` compact and rely on `text` for primary output.
- **Multiple tabs**: host spawns one HTTP server per enabled tab. That’s fine for small N; document expected limits.

---

# Testing notes

Manual testing checklist:

- Load extension unpacked.
- Run native host installer script.
- Enable Argus on a tab that logs.
- In another terminal:
    - `argus list` shows `ext-tab-<tabId>` watcher(s) reachable.
    - `argus tail ext-tab-<tabId>` streams logs.
    - `argus logs ext-tab-<tabId> --since 1m` returns recent history.
- Disable tab in extension; watcher disappears from `argus list` after TTL/heartbeat pruning.

---

# Final checklist

After implementation: run `npm run typecheck` and `npm run lint` and fix any errors (use `npm run lint:fix` when appropriate).
