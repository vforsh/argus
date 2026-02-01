# Stage 06 - Protocol Files Split + API Version

Targets:

- `packages/argus-core/src/protocol/http.ts` (monolith types)
- Watcher `/status` builder + clients that read it

## Intent

- Make protocol changes local (edit one domain file).
- Prevent silent CLI<->watcher drift by advertising protocol version.

## Scope

- Type-only refactor in `@vforsh/argus-core` (split files + re-exports).
- Add optional version fields to `/status` response.
- No endpoint/path changes.

## Steps

1. Split protocol types by domain

- New folder: `packages/argus-core/src/protocol/http/`
    - `status.ts` -> `StatusResponse`
    - `logs.ts` -> `LogsResponse`, `TailResponse`
    - `net.ts` -> `NetworkRequestSummary`, `NetResponse`, `NetTailResponse`
    - `eval.ts` -> `EvalRequest`, `EvalResponse`
    - `trace.ts` -> `TraceStartRequest/Response`, `TraceStopRequest/Response`
    - `screenshot.ts` -> `ScreenshotRequest/Response`
    - `snapshot.ts` -> `SnapshotRequest/Response` (+ ax types if needed)
    - `dom.ts` -> `Dom*` request/response types
    - `storage.ts` -> `StorageLocalRequest` (+ response type if any)
    - `errors.ts` -> `ErrorResponse`
- Keep `packages/argus-core/src/protocol/http.ts` as re-export barrel to avoid breaking imports.

2. Add protocol version constants

- New `packages/argus-core/src/protocol/version.ts`
    - `export const ARGUS_PROTOCOL_VERSION = 1 as const`
    - `export type ArgusProtocolVersion = typeof ARGUS_PROTOCOL_VERSION`

3. Extend `StatusResponse` (backward-compatible)

- In `status.ts`:
    - add optional fields (do not break older watchers/clients):
        - `protocolVersion?: ArgusProtocolVersion`
        - `watcherVersion?: string` (package version string; optional)
- Watcher: include these in `/status` payload.
    - `protocolVersion: ARGUS_PROTOCOL_VERSION`
    - `watcherVersion`: from package.json at build time (or omit if annoying)

4. Client/CLI handling

- `resolveWatcher` reachability checks should not depend on new fields.
- `argus list` output may optionally show version mismatch warnings:
    - only warn if both sides present and differ.
    - do not change exit code.

## Acceptance criteria

- No import churn required for downstream packages (barrel keeps old paths).
- Stage 01 Playground tests still green.

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`
