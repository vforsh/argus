# Stage 01 - Playground Gate Tests

Intent: make "Playground-related tests must pass after each stage" enforceable + repeatable.

## Scope

- Add a dedicated test file(s) that boots the Playground and runs a small command matrix against it.
- Add an npm script alias (fast) to run only those tests.
- Keep existing `npm run test:e2e` unchanged (still available).

Non-goals:

- Full e2e coverage for every command.
- CI redesign.

## Proposed implementation

1. Add script:

- `package.json`: `test:playground` -> `bun run build:packages && bun test e2e/playground-*.test.ts`
    - Reason: use bundled CLI (`packages/argus/dist/bin.js`) like existing e2e tests; catches bundling regressions.

2. Add test harness:

- New `e2e/playground-smoke.test.ts`
    - Start Playground servers:
        - reuse `playground/serve.ts` directly (import + startServer) OR spawn `bun playground/serve.ts`
    - Launch Chromium with known remote-debugging port (Playwright), open `playground/index.html`
    - Start watcher via fixture `e2e/fixtures/start-watcher.ts` (like other e2e)
    - Run CLI commands against watcher (via `packages/argus/dist/bin.js`):
        - `argus eval playground "window.playground.ready" --json` (or `eval-until`)
        - `argus dom tree playground --selector "body" --depth 2 --json`
        - `argus dom info playground --selector '[data-testid=\"article-1\"]' --json`
        - `argus storage local list playground --json`
        - `argus eval playground "window.iframeState" --iframe "#playground-iframe" --json`
        - `argus eval playground "window.iframeState" --iframe "#cross-origin-iframe" --json` (cross-origin postMessage path)
        - `argus screenshot playground --json` (assert `outFile` exists)

3. Standardize test env:

- Use temp `ARGUS_HOME` per test (already pattern).
- Ports: reuse `e2e/helpers/ports.ts` + pick 3333/3334 only if free; otherwise random ports (pass to playground server).

## Acceptance criteria

- `npm run test:playground` green locally.
- Tests deterministic: no sleeping-only; prefer polling `/status` like existing e2e.
- No changes required to manual `npm run playground`.

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`
