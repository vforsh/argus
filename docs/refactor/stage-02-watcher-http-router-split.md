# Stage 02 - Watcher HTTP Router Split

Target: `packages/argus-watcher/src/http/server.ts` (too large; mixes routing + validation + business logic).

## Intent

- Reduce merge conflicts and change-cost for new endpoints.
- Make route ownership obvious (1 file per endpoint).
- Keep wire protocol stable.

## Scope

- Internal refactor only (no API changes).
- Move handlers into route modules.
- Replace giant `if (method/path)` chain with a small router map.

Non-goals:

- Switch to a framework (express/elysia/etc). Keep `node:http`.
- Rework response payload types.

## Steps

1. Introduce route context type

- New `packages/argus-watcher/src/http/routes/types.ts`
    - `RouteContext`: subset of `HttpServerOptions` actually needed by handlers.
    - `RouteHandler`: `(req, res, url, ctx) => Promise<void> | void`

2. Extract handlers to route files (no behavior change)

- New folder: `packages/argus-watcher/src/http/routes/`
- Files (examples; keep 1 route per file):
    - `getStatus.ts` -> `GET /status`
    - `getLogs.ts` -> `GET /logs`
    - `getTail.ts` -> `GET /tail`
    - `getNet.ts` -> `GET /net`
    - `getNetTail.ts` -> `GET /net/tail`
    - `postEval.ts` -> `POST /eval`
    - `postTraceStart.ts` -> `POST /trace/start`
    - `postTraceStop.ts` -> `POST /trace/stop`
    - `postScreenshot.ts` -> `POST /screenshot`
    - `postSnapshot.ts` -> `POST /snapshot`
    - `postDomTree.ts` -> `POST /dom/tree`
    - ... continue for dom/\*, storage/local, reload, shutdown, targets/attach/detach

3. Add router table

- New `packages/argus-watcher/src/http/router.ts`
    - Build key: `${method} ${pathname}`
    - Map to handler
    - One place for 404/405 fallback

4. Shrink `server.ts`

- Keep `startHttpServer` + types + imports glue.
- Route dispatch: parse URL once -> router lookup -> handler.

5. Keep request event metadata

- Ensure every extracted handler calls `options.onRequest?.({...})` with same endpoint strings as before.
- Add small helper in `routes/_onRequest.ts` if needed to avoid drift.

## Acceptance criteria

- No diff in JSON responses for a representative command set (spot check via `npm run playground` manual or stage-01 tests).
- `packages/argus-watcher/src/http/server.ts` <= ~250 LOC and mostly glue.

## Verify (end of stage)

- `npm run typecheck`
- `npm run test:playground`
