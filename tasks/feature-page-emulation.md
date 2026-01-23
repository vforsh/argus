## Goal

Add **page-level CDP emulation controls** to Argus so the CLI can:

- **Set** device emulation (viewport/DPR/mobile + touch + UA override) on the watcher-attached page.
- **Clear** emulation back to defaults.
- **Query** current emulation state (“what is currently running?”).
- Support **device presets + flag overrides**, with stable JSON output for automation.

CLI location per decision: **`argus page emulation ...`**.

---

## Current state

- **Watcher** attaches to a CDP target via `startCdpWatcher` and exposes an HTTP API in `packages/argus-watcher/src/http/server.ts`.
    - The attach lifecycle supports hooks via `onAttach` in `packages/argus-watcher/src/cdp/watcher.ts` and is wired from `packages/argus-watcher/src/index.ts`.
- **CLI** commands are defined in `packages/argus/src/bin.ts` and usually call watcher endpoints via `fetchJson` (see `dom hover/click`).
- **Shared HTTP protocol types** live in `packages/argus-core/src/protocol/http.ts` and are imported by both CLI and watcher.
- There is **no emulation support** currently; CDP doesn’t provide “get current overrides”, so **query requires watcher-maintained state**.

---

## Proposed design

### HTTP API (watcher)

Add a new watcher endpoint group:

- `GET /emulation` → return **current emulation status** (including whether the watcher is attached, current desired state, and whether it’s applied vs pending).
- `POST /emulation` → accept an action-based request:
    - `{ action: "set", state: ... }`
    - `{ action: "clear" }`

Rationale: matches the existing “action” pattern used by `/storage/local` while keeping the surface small.

### Protocol types (argus-core)

Add types to `packages/argus-core/src/protocol/http.ts` (with JSDoc since this is public API):

- `EmulationViewport`:
    - `width: number` (int > 0)
    - `height: number` (int > 0)
    - `deviceScaleFactor: number` (finite > 0)
    - `mobile: boolean`
- `EmulationState`:
    - `viewport?: EmulationViewport | null`
    - `touch?: { enabled: boolean } | null`
    - `userAgent?: { value: string | null } | null` (null = “use baseline/default”)
- `EmulationRequest`:
    - `| { action: 'set'; state: EmulationState }`
    - `| { action: 'clear' }`
- `EmulationSetResponse`:
    - `ok: true`
    - `attached: boolean`
    - `applied: boolean` (true if applied to current CDP session; false if queued because detached)
    - `state: EmulationState | null` (the desired state after the operation)
    - `error?: { message: string; code?: string } | null` (optional; for “applied=false due to apply failure” while still returning ok)
- `EmulationClearResponse`: same shape as set, but `state: null`
- `EmulationStatusResponse`:
    - `ok: true`
    - `attached: boolean`
    - `applied: boolean` (whether desired state is currently applied to the attached target)
    - `state: EmulationState | null`
    - `baseline: { userAgent: string | null }` (best-effort; null when detached or not yet resolved)
    - `lastError?: { message: string; code?: string } | null`

Notes:

- Keep the type minimal; only include knobs we actually support in v1 (viewport/DPR/mobile, touch, UA).
- Ensure the watcher can always answer `GET /emulation` even when detached.

### Watcher implementation

Create a small emulation controller that owns state + apply/clear logic.

**New module:** `packages/argus-watcher/src/cdp/emulation.ts`

- `applyEmulation(session, state, baseline)`:
    - Guard clauses: if state is null → no-op
    - If `state.viewport` present:
        - `Emulation.setDeviceMetricsOverride` with `width`, `height`, `deviceScaleFactor`, `mobile`
    - Else:
        - `Emulation.clearDeviceMetricsOverride`
    - If `state.touch` present:
        - `Emulation.setTouchEmulationEnabled` with `enabled`
    - Else:
        - default to `enabled=false` (explicitly disable)
    - If `state.userAgent?.value` is a non-null string:
        - `Emulation.setUserAgentOverride` with that UA
    - Else if `baseline.userAgent` is non-null:
        - Restore baseline UA with `Emulation.setUserAgentOverride` (since there is no “clear UA override” primitive)

**New module:** `packages/argus-watcher/src/emulation/EmulationController.ts`

State:

- `desired: EmulationState | null`
- `applied: boolean`
- `baselineUserAgent: string | null`
- `lastError: { message: string; code?: string } | null`

Behavior:

- `getStatus({ attached })` → build `EmulationStatusResponse`
- `setDesired(state)`:
    - Save `desired`
    - If not attached → mark `applied=false` and return `{ applied: false }`
    - If attached → call `applyEmulation`, update `applied` and `lastError`
- `clearDesired()`:
    - Set `desired=null`
    - If attached → call `applyEmulation(session, null, baseline)` or an explicit `clearEmulation`
- `onAttach(session)`:
    - Refresh `baselineUserAgent` (best effort):
        - `Runtime.evaluate('navigator.userAgent')` with `returnByValue: true`
    - If `desired` is non-null → re-apply it (persist-until-clear semantics)

Wire into lifecycle:

- In `packages/argus-watcher/src/index.ts`, extend the existing `onAttach` hook to also call `emulationController.onAttach(session)`.
    - Keep guard-clause style; failures should set `lastError` and log a single warning (avoid noisy spam).

Add HTTP routes in `packages/argus-watcher/src/http/server.ts`:

- `GET /emulation` → `respondJson(res, emulationController.getStatus({ attached: cdpStatus.attached }))`
- `POST /emulation`:
    - Validate `action`
    - If `action==='set'`, validate payload invariants:
        - If `viewport` provided: require width+height ints > 0, deviceScaleFactor finite > 0, mobile boolean
        - If `userAgent.value` provided: must be non-empty string (or allow empty to mean “clear”; recommended: reject empty)
    - Call controller methods; return typed response

### CLI implementation

Add `page emulation` group under `page` in `packages/argus/src/bin.ts`:

- `argus page emulation set [id]`
- `argus page emulation clear [id]`
- `argus page emulation status [id]`

Where `[id]` is the **watcher id** (same meaning as `dom click app ...`). This keeps “emulation is managed by watcher state” consistent with “query current emulation”.

**New CLI command runner:** `packages/argus/src/commands/pageEmulation.ts`

Shared behaviors:

- Use `resolveWatcher({ id })` and print watcher candidates on resolution error (same pattern as `domClick.ts`).
- Use `fetchJson` with:
    - `GET http://{host}:{port}/emulation` for status
    - `POST http://{host}:{port}/emulation` for set/clear
- Support `--json` to print raw JSON response.

#### Presets + overrides

Implement device presets in CLI only:

- `packages/argus/src/emulation/devices.ts`
    - A curated, stable set (e.g. “iphone-14”, “pixel-7”, “ipad-mini”, “desktop-1440”).
    - Each preset maps to an `EmulationState` (viewport + touch + UA).
    - Provide a resolver that matches case-insensitively and supports a few aliases.

`set` flags:

- `--device <name>` (optional)
- `--width <n>` and `--height <n>` (override viewport)
- `--dpr <n>` (override deviceScaleFactor)
- `--mobile` / `--no-mobile`
- `--touch` / `--no-touch`
- `--ua <string>` (override user agent)
- `--json`

Resolution algorithm (guard-clause heavy):

- Start with preset state if `--device` provided; error if unknown.
- Apply explicit overrides (width/height/dpr/mobile/touch/ua).
- Validate:
    - If any of width/height is set, require both.
    - If no preset and no viewport provided → error (we need enough info to emulate something).
- Send resolved `EmulationRequest` `{ action:'set', state }`.

Human output examples:

- `Applied emulation: viewport=390x844@3 mobile touch ua=overridden`
- `Queued emulation (watcher detached): will apply on next attach`
- `Cleared emulation (restored baseline UA + metrics)`

---

## Touch points (file-by-file)

**argus-core**

- `packages/argus-core/src/protocol/http.ts`
    - Add Emulation request/response/state types + exports (JSDoc required).
- `packages/argus-core/src/index.ts`
    - Ensure new protocol types are exported (if index is explicit; verify and update as needed).

**argus-watcher**

- `packages/argus-watcher/src/cdp/emulation.ts` (new)
- `packages/argus-watcher/src/emulation/EmulationController.ts` (new)
- `packages/argus-watcher/src/index.ts`
    - Instantiate controller and call `onAttach`.
- `packages/argus-watcher/src/http/server.ts`
    - Add `GET /emulation` and `POST /emulation` handlers.

**argus (CLI)**

- `packages/argus/src/bin.ts`
    - Add `page emulation` subcommands wiring to runners.
- `packages/argus/src/commands/pageEmulation.ts` (new)
- `packages/argus/src/emulation/devices.ts` (new)

---

## Rollout order

1. Add protocol types in `argus-core` and export them.
2. Implement watcher emulation apply/clear helpers and controller (no HTTP yet).
3. Add watcher HTTP routes and validate end-to-end via manual curl.
4. Add CLI `page emulation` commands (status first, then set/clear).
5. Add/adjust e2e coverage (at least one test that sets emulation then reads status; optional if test harness doesn’t have a stable page fixture).

---

## Risks / edge cases

- **No CDP “get current emulation”**: status must reflect watcher-maintained state. Mitigation: controller is the single writer of emulation changes, and re-applies on every attach.
- **UA reset semantics**: there is no direct “clear UA override”.
    - Mitigation: capture `navigator.userAgent` as baseline on attach and restore it on clear / “ua=null”.
- **Detach/reattach**: “persist until clear” means emulation should be re-applied automatically when a new target is attached.
- **Partial state**: a preset might set UA + metrics + touch; user overrides should not produce invalid combinations (e.g. width without height).
- **Apply failures** (CDP rejects values): keep `desired` state but mark `applied=false` and surface `lastError` in status for visibility.

---

## Testing notes

- **Manual smoke**:
    - Start chrome + watcher, confirm attached.
    - `argus page emulation set app --device iphone-14`
    - `argus page emulation status app` → shows `attached=true`, `applied=true`, viewport/touch/ua fields.
    - `argus page emulation clear app` → status returns `state=null`.
    - Stop watcher, restart watcher (or navigate to a new matching tab), confirm that a previously set state is re-applied on attach (until cleared).

- **Automated (optional e2e)**:
    - Use the existing e2e harness to start watcher + attach to a known page and assert:
        - status reports applied after set
        - status reports cleared after clear

---

## Final checklist

Run `npm run typecheck:packages` and `npm run lint` (use `npm run lint:fix` when appropriate), and fix any errors found.
