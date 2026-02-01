# Stage 05 - CLI Request + Error Unification

Problem: each command reimplements resolve-watcher + URL build + fetch + error/exit handling.
Targets: `packages/argus/src/commands/*`, `packages/argus/src/httpClient.ts`, `packages/argus/src/watchers/resolveWatcher.ts`.

## Intent

- Cut duplication; make new command implementation mostly "build request, format output".
- Consistent errors + exit codes across commands.
- Prepare for Stage 06 endpoint map usage.

## Scope

- Internal refactor in `@vforsh/argus` only.
- No CLI flag changes.

## Steps

1. Introduce shared request helper

- New `packages/argus/src/watchers/requestWatcher.ts`
    - `requestWatcherJson<TSuccess, TError>(input)`
        - resolves watcher (id/cwd/reachable heuristic)
        - builds URL from `path` + watcher host/port
        - calls `fetchJson` with `returnErrorResponse` optional
        - returns typed result:
            - `{ ok: true, watcher, data }`
            - `{ ok: false, watcher?, exitCode, message, errorCode?, data? }`

2. Unify "unreachable watcher" behavior

- Option A (safer, default): do not mutate registry; just message + exitCode=1.
- Option B (cleaner UX): on connection failure, remove watcher from registry (like `@vforsh/argus-client`).
    - If chosen: implement as opt-in behind env flag first (e.g. `ARGUS_PRUNE_UNREACHABLE=1`), then flip default later.

3. Centralize common parsing

- New `packages/argus/src/cli/parse.ts`
    - `parsePositiveIntFlag(value, { allowZero })`
    - `parseDurationFlag(value)` (already in `time.ts`; reuse)
    - `parseCsvFlag(value)`
- Commands switch to shared parsers; reduce per-file helpers like `parsePositiveInt` in `packages/argus/src/commands/domTree.ts`.

4. Apply to a small vertical slice first

- Convert 3-4 commands end-to-end to validate helper shape:
    - `logs`, `net`, `dom tree`, `eval`
- Keep response formatting unchanged.

5. Roll out to remaining commands

- Mechanical refactor; avoid behavior changes.
- Delete redundant `formatError` / parse helpers per command after migration.

## Acceptance criteria

- Net diff in each converted command file is mostly deletion.
- Error messages remain stable (spot check for common failures).
- New command authoring path: add a request call + print.

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`
