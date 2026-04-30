# Watcher Command Migration

This note tracks the follow-up work needed to finish migrating CLI commands and watcher routes to the new shared helpers:

- `packages/argus/src/cli/defineWatcherCommand.ts`
- `packages/argus-watcher/src/http/routes/defineJsonRoute.ts`
- `packages/argus-watcher/src/http/routes/defineDomTargetRoute.ts`

Goal: keep command/route files focused on command-specific validation, request shape, and human output. Shared plumbing should stay in helpers: output setup, watcher request handling, protocol validation, JSON-vs-human dispatch, route body parsing, event emission, and standard error responses.

## Current State

Already migrated CLI command files:

- `packages/argus/src/commands/dialog.ts`
- `packages/argus/src/commands/domClick.ts`
- `packages/argus/src/commands/domFill.ts`
- `packages/argus/src/commands/domFocus.ts`
- `packages/argus/src/commands/domHover.ts`
- `packages/argus/src/commands/domRemove.ts`
- `packages/argus/src/commands/domSetFile.ts`
- `packages/argus/src/commands/pageVisibility.ts`
- `packages/argus/src/commands/reload.ts`
- `packages/argus/src/commands/snapshot.ts`
- `packages/argus/src/commands/storage.ts`
- `packages/argus/src/commands/throttle.ts`

Already migrated watcher route files:

- `packages/argus-watcher/src/http/routes/postDomClick.ts` uses `defineJsonRoute`
- `packages/argus-watcher/src/http/routes/postDomFocus.ts` uses `defineDomTargetRoute`
- `packages/argus-watcher/src/http/routes/postDomHover.ts` uses `defineDomTargetRoute`

## CLI Work Remaining

These files still call `requestWatcherJson` or `requestWatcherAction` directly and are candidates for `defineWatcherCommand`:

- `packages/argus/src/commands/auth.ts`
- `packages/argus/src/commands/authCookies.ts`
- `packages/argus/src/commands/authCookieSupport.ts`
- `packages/argus/src/commands/code.ts`
- `packages/argus/src/commands/codeEdit.ts`
- `packages/argus/src/commands/domAdd.ts`
- `packages/argus/src/commands/domInfo.ts`
- `packages/argus/src/commands/domKeydown.ts`
- `packages/argus/src/commands/domModify.ts`
- `packages/argus/src/commands/domScroll.ts`
- `packages/argus/src/commands/domScrollTo.ts`
- `packages/argus/src/commands/domTree.ts`
- `packages/argus/src/commands/locate.ts`
- `packages/argus/src/commands/logs.ts`
- `packages/argus/src/commands/net.ts`
- `packages/argus/src/commands/netClear.ts`
- `packages/argus/src/commands/pageEmulation.ts`
- `packages/argus/src/commands/screenshot.ts`
- `packages/argus/src/commands/watcherStatus.ts`

Migration rules:

- Use `defineWatcherCommand` when the command performs a one-shot watcher HTTP request and then writes JSON or human output.
- Keep streaming/long-running commands on custom runners unless the helper gains streaming support. Do not force `tail`, `watch`, or loop-style commands into this helper.
- Keep command-specific validation in `build`. Return `null` after writing a warning and setting `process.exitCode` when validation fails.
- Use `schema` when a protocol schema exists. Do not add ad hoc runtime validation in the helper.
- Use tuple args for positional command arguments, e.g. `[key: string]`, `[key: string, value: string]`.
- Use `formatHuman` for human output. Let default JSON output return the success response unless a command intentionally exposes a different JSON payload.

Suggested order:

1. Simple one-shot commands: `screenshot.ts`, `watcherStatus.ts`, `netClear.ts`, `domKeydown.ts`.
2. DOM selector commands: `domTree.ts`, `domInfo.ts`, `domScroll.ts`, `domScrollTo.ts`, `domAdd.ts`.
3. Multi-action files: `domModify.ts`, `authCookies.ts`, `pageEmulation.ts`.
4. Larger feature files: `code.ts`, `codeEdit.ts`, `net.ts`, `logs.ts`, `locate.ts`, `auth.ts`, `authCookieSupport.ts`.

## Route Work Remaining

Most watcher route files still use manual body parsing, event emission, response writing, and error handling. Migrate them incrementally to `defineJsonRoute` or a narrow domain helper.

Use `defineJsonRoute` when:

- the route is a normal JSON GET/POST handler;
- body parsing and schema validation are straightforward;
- the route can return an object response instead of calling `respondJson` itself;
- common error handling via `respondError` is enough.

Use `defineDomTargetRoute` when:

- the route resolves one DOM target by selector/ref;
- it uses the standard `all` and `text` semantics;
- it needs the standard missing-ref and multiple-match responses;
- the action is a no-op on empty handle arrays or can return a consistent zero-count response.

Do not force a route into these helpers when it streams, proxies, writes partial responses, upgrades connections, or has unusual response timing.

High-value route candidates:

- DOM target/action routes: `postDomFill.ts`, `postDomSetFile.ts`, `postDomScroll.ts`, `postDomScrollTo.ts`, `postDomInfo.ts`, `postDomTree.ts`, `postDomKeydown.ts`, `postDomRemove.ts`, `postDomModify.ts`, `postDomAdd.ts`.
- Simple JSON routes: `postReload.ts`, `postSnapshot.ts`, `postScreenshot.ts`, `postThrottle.ts`, `getThrottle.ts`, `postDialog.ts`, `getDialog.ts`, `postVisibility.ts`, `postStorageLocal.ts`, `postStorageSession.ts`.
- Code routes: `postCodeList.ts`, `postCodeRead.ts`, `postCodeGrep.ts`, `postCodeEdit.ts`.
- Network routes: `getNet.ts`, `getNetRequests.ts`, `getNetRequest.ts`, `getNetRequestBody.ts`, `getNetTail.ts`, `postNetClear.ts`.

## Protocol Schemas

`defineWatcherCommand` and `defineJsonRoute` both work best when request payload schemas live in `argus-core`.

Before migrating a route with non-trivial body validation:

1. Add or reuse a protocol request type in `packages/argus-core/src/protocol/http/*`.
2. Add a `defineProtocolSchema` validator next to the request type.
3. Use that schema from both CLI build validation and watcher route validation.
4. Preserve the existing HTTP response shape: success `{ ok: true, ... }`, failure `{ ok: false, error: { message, code? } }`.

Do not create schema shims just to finish a migration. If a route has manual validation that encodes real product behavior, move that behavior into `argus-core` first.

## Per-Command Migration Checklist

For each CLI command:

1. Confirm it is a one-shot watcher request.
2. Extract command-specific validation/body creation into `build`.
3. Preserve every warning string, JSON shape, human output line, timeout, method, path, and exit code.
4. Add tuple args for positional inputs instead of threading data through mutated options objects.
5. Remove direct `requestWatcherJson` / `requestWatcherAction` usage from the command file.
6. Run focused smoke commands against the playground when the command touches DOM, page, network, storage, dialogs, screenshots, or runtime code.

For each watcher route:

1. Decide between `defineJsonRoute`, `defineDomTargetRoute`, or no helper.
2. Move body parsing/schema validation into the helper input.
3. Return response objects instead of manually calling `respondJson` when practical.
4. Preserve event endpoint names passed to `emitRequest`.
5. Preserve special errors such as `multiple_matches`, `invalid_ref`, and route-specific validation messages.

## Verification

After each migration batch:

1. Run `npm run typecheck`.
2. Run `npm run lint` and use `npm run lint:fix` only for auto-fixable issues.
3. Rebuild changed packages with `npm run build:packages` when touching `packages/*`.
4. Use the playground for behavior checks:
    - Start it with `npm run playground`.
    - Use watcher id `playground`.
    - Smoke-test human output, `--json`, validation failures, and at least one server-side error/no-match path.

Suggested focused playground smoke tests:

- DOM: `argus dom tree playground --selector body --depth 1`
- Click/fill/focus/hover: use `[data-testid="btn-log"]` and `[data-testid="input-name"]`
- Storage: set/get/remove a temporary localStorage key
- Dialogs: trigger `confirm()` or `prompt()` via `argus eval`, then handle via `argus dialog`
- Screenshot/snapshot: verify both human and `--json` paths where available

## Done Criteria

The migration is complete when:

- no one-shot CLI command files call `requestWatcherJson` or `requestWatcherAction` directly;
- normal JSON watcher routes use `defineJsonRoute` or a small domain-specific helper;
- remaining manual handlers are intentionally manual and documented by nearby comments;
- protocol request schemas exist for non-trivial request bodies;
- `npm run typecheck`, `npm run lint`, and `npm run build:packages` pass;
- playground smoke tests cover the migrated command families.
