# Refactor Plan (Incremental, Always Green)

Goal: reduce change-cost for new commands/endpoints. Keep repo shippable after every stage.

Global invariants (every stage):

- No CLI surface breaking changes unless explicitly called out.
- Keep behavior identical unless stage says otherwise.
- After stage completion: `npm run typecheck` + Playground-related tests green.

## Stages

1. ~~[Stage 01 - Playground Gate Tests](./stage-01-playground-gates.md)~~ ✅
    - Add a dedicated, repeatable "playground smoke" test suite + script.
    - Makes the "Playground tests must pass after each stage" requirement enforceable.

2. [Stage 02 - Watcher HTTP Router Split](./stage-02-watcher-http-router-split.md)
    - Split `packages/argus-watcher/src/http/server.ts` into route modules; keep API stable.
    - Centralize request parsing/validation per route.

3. [Stage 03 - Watcher CDP DOM Module Split](./stage-03-watcher-cdp-dom-split.md)
    - Split `packages/argus-watcher/src/cdp/dom.ts` by concerns (query/match/tree/info/modify).
    - Keep exports used by HTTP layer unchanged.

4. [Stage 04 - CLI Command Registration Split](./stage-04-cli-command-registration-split.md)
    - Split `packages/argus/src/bin.ts` into command "register" modules.
    - Reduce merge conflicts; improve locality per command family.

5. [Stage 05 - CLI Request + Error Unification](./stage-05-cli-request-unification.md)
    - Extract shared resolve-watcher + fetch + error mapping helpers.
    - Align CLI and `@vforsh/argus-client` behaviors (timeouts, unreachable watcher handling).

6. [Stage 06 - Protocol Files Split + API Version](./stage-06-protocol-split-and-versioning.md)
    - Split `packages/argus-core/src/protocol/http.ts` into domain modules.
    - Add `apiVersion` / `protocolVersion` to `/status` to prevent silent drift.

7. [Stage 07 - Registry Concurrency Hardening](./stage-07-registry-concurrency.md)
    - Reduce lost updates when multiple watchers write registry concurrently.
    - Keep backward compatibility (read old file; write new safe format or lock writes).

## Final checklist

- Run `npm run typecheck` + `npm run lint` and fix any errors (use `npm run lint:fix` when appropriate).
- Run Playground test suite and fix failures; then run full `npm run test:e2e` once.
