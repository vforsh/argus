# AGENTS.md

Argus: terminal-first debugging for Chromium apps (CLI + watcher over CDP or the Argus extension). Bun workspace, TypeScript 7 (`tsc`).

## Repo Map

- **`packages/argus`**: CLI app. Entry `src/bin.ts`; registration order in `src/cli/register/index.ts` (`coreProgramRegistrars`), flags/help in `src/cli/register/*`; implementations in `src/commands/*` (mostly `defineWatcherCommand`); plugin loading in `src/cli/plugins/`. Lightweight command manifests defer actions via `src/cli/lazyAction.ts`; `scripts/bundle-argus.mjs` emits `dist/argus.js` plus lazy `dist/chunks/` (ship both).
- **`packages/argus-watcher`**: watcher server. Routes in `src/http/routes/*` (`defineJsonRoute` in `defineRoute.ts`, `defineExtensionRoute`), registered in `routes/index.ts` (`watcherRoutes`), dispatched by `src/http/router.ts`; endpoint names in `src/http/endpoints.ts` (`WATCHER_ENDPOINTS`); response helpers in `src/http/httpUtils.ts`.
- **`packages/argus-core`**: protocol types and schemas: `src/protocol/http/*`, `src/protocol/schemaFields.ts`, `src/protocol/native-messaging.ts`, `src/protocol/version.ts`. Must stay dependency-free.
- **`packages/argus-client`**: SDK, `src/client/createArgusClient.ts`.
- **`packages/argus-plugin-api`**: versioned types for CLI plugins (`ArgusPluginHostV1`, `ARGUS_PLUGIN_API_VERSION`).
- **`packages/argus-extension`**: Chrome extension (esbuild bundle, own tsconfig). Frame table in `src/background/frame-table.ts`.
- **`skill/argus/`**: AI-facing CLI cheat sheet (`SKILL.md`) plus advanced topics in `reference/`. Copied into the CLI build.
- **Tests**: `e2e/*.test.ts` (integration), `packages/*/test` (existing package tests), `playground/` (manual harness + suite helpers).

---

## Commands

Root `package.json` and `packages/*/package.json` are authoritative.

- **Install**: `bun install`. Bun is the runtime and package manager.
- **Build all packages**: `npm run build:packages` (cleans `dist/`, runs `tsc -b`, bundles the CLI). Required before the `argus` bin reflects source changes.
- **Build one package**: `bun run --cwd packages/<name> build` (e.g. `packages/argus-core`). Building `packages/argus` also builds its referenced packages and re-bundles.
- **Build extension**: `npm run build:extension`.
- **Typecheck (full gate)**: `npm run typecheck` (app + shared packages + extension + tests). Focused: `typecheck:app`, `typecheck:packages`, `typecheck:extension`, `typecheck:tests` (`e2e/`, `packages/*/test`, `packages/*/scripts`, and the playground modules they import).
- **Tests**: see [Verification](#verification).
- **No lint/format scripts**: there is no `npm run lint` and no formatter on commit. Oxfmt in `packages/argus` is a runtime dependency for code deminify (`src/runtime-code/format.ts`), not repo tooling.

**Builds must be serial.** Never run `clean`, `tsc -b`, `build:*`, or Bun bundle steps in parallel with anything that reads `dist/`. `clean` deletes emitted files first, so a concurrent reader sees half-built output and reports fake "missing export" errors. If an error points at `packages/*/dist/*`, rebuild serially before treating it as a source bug.

---

## Code Rules

- **Style**: tabs, no semicolons, single quotes, ~150-char lines. Applied by hand; match surrounding code.
- **File size**: keep files under ~500 LOC. Split into cohesive helpers/subcomponents before a file sprawls.
- **Structure**: guard clauses and early returns over nesting. Order functions by call sequence (caller before callee); keep helpers next to their only caller.
- **Dependencies**: prefer Bun/Node built-ins. Add deps to the package that needs them, never root. `argus-core` stays dependency-free.
- **Public API JSDoc**: anything exported from `packages/*` for other packages documents params, return values, and invariants/edge cases.
- **Skill docs**: adding or changing a CLI command means updating `skill/argus/SKILL.md` (minimal, behavior-focused examples; advanced topics in `skill/argus/reference/`).
- **Root cause**: fix the violated invariant, not the symptom. Add guards/fallbacks only when product-required.
- **Breadcrumbs**: leave short notes on non-obvious decisions and rejected approaches, naming key files/functions.
- **Plans**: implementation/refactor plans end with a 1–2 sentence checklist: run `npm run typecheck` and relevant integration/e2e checks, fix what fails.

---

## Golden Paths

- **New CLI command (no new watcher API)**: register in `src/cli/register/*` → implement in `src/commands/*` → support `--json` → add/adjust `e2e/*` → update `SKILL.md`.
- **New watcher endpoint**: request/response types **and** a request `ProtocolSchema` in `argus-core/src/protocol/http/<domain>.ts` → add the name to `WATCHER_ENDPOINTS` → route file in `argus-watcher/src/http/routes/` via `defineJsonRoute` → add it to `watcherRoutes` in `routes/index.ts` → call from CLI (`defineWatcherCommand`) and SDK (`createArgusClient`) → `e2e/*` → `SKILL.md` → playground controls if interactive.
- **Extension-only route**: use `defineExtensionRoute` with the needed `capability`. It owns the availability guard, the `not_available` response, and `extension_action_failed` mapping; don't re-check `ctx.sourceHandle?.x` in the handler.
- **Protocol changes**: additive by default. Breaking changes bump `ARGUS_PROTOCOL_VERSION` (`protocol/version.ts`). Keep `ok`/`error` shapes stable.

---

## Contracts / Invariants

- **Response envelope**: success is `Ok<{…}>`; failure is `ok: false` with `{ error: ErrorDetail }` (`argus-core/src/protocol/http/errors.ts`). Consumers take `ApiResult<TResponse>`, not hand-written `TResponse | ErrorResponse`.
- **Error codes are a closed union**: add to `ARGUS_ERROR_CODES` before emitting a new code. `codedError`/`getErrorCode` are typed to it, so foreign codes (Node's `ENOENT`) can't reach the wire and renames break readers at compile time.
- **Query params are typed**: GET params live in `protocol/http/query.ts` (`LogsQuery`, `NetQuery`), serialized with `toSearchParams`. CLI and SDK build those shapes; the watcher reads them via `keyof`-checked helpers. No ad-hoc `params.set('…')`.
- **POST bodies are schema-only**: a route reads a body only by declaring `bodySchema`. Write the `ProtocolSchema` next to the request type, composed from `protocol/schemaFields.ts` readers; no hand-rolled `typeof` checks in routes.
- **`cdp_event` carries only real Chrome events**: the extension never fabricates one. The extension owns the frame table and sends full, deduplicated `frame_snapshot` messages; the watcher applies every snapshot (pushed or pulled) through `applyExtensionFrameSnapshot` and runs navigation side effects (log rotation, sourcemap reset, indicator) only on the real top-frame `Page.frameNavigated`. Synthesized events double-fire those effects.
- **Frame snapshots apply in wire order**: `SessionManager.handleFrameSnapshot` applies a pull reply before resolving its promise. Applying it in the awaiting caller runs a microtask later, after events that arrived behind it, and the stale table deletes frames those events created.
- **Native messaging is versioned**: the `host_info` handshake rejects mismatched peers, so extension and CLI ship as a pair. Additive fields need no bump; a new required message or changed shape bumps `NATIVE_MESSAGING_PROTOCOL_VERSION`.

---

## Verification

- **No new unit tests**: don't add unit tests or unit-test targets. Existing package tests (`npm run test:unit`) may be run. Verify with typecheck, integration/e2e, and playground smoke checks.
- **After package changes**: rebuild the affected package(s) serially, then typecheck, before testing.
- **Quick**: `npm run typecheck`.
- **Focused**: `npm run test:playground` (builds packages, runs `e2e/playground-*.test.ts` in a real browser) or `npm run test:unit` (`packages/*/test`, no browser).
- **Extension**: `npm run test:e2e:extension` for any change to `packages/argus-extension` or the extension source in `argus-watcher`. Runs real Chromium with the unpacked extension and real native hosts in a temp profile. Needs Chrome for Testing/Chromium (branded Chrome 137+ ignores `--load-extension`): found in the Playwright cache or via `ARGUS_E2E_CHROME_BIN`. **Without a binary it skips itself; a green run with a skip warning proves nothing.** `ARGUS_E2E_HEADED=1` to watch.
- **Full**: `npm run test:e2e` builds packages + extension, runs `test:unit`, then each `e2e/*.test.ts` serially (`scripts/test-e2e.mjs`). Slow; run when the change warrants it.

### Playground

- **What**: self-contained harness (`playground/`) with console/network/DOM/storage/eval/iframe sections, API stubs, and an orchestrator for Chrome + watcher.
- **Run**: `npm run playground` (long-running; start it in the background). Serves `:3333` and cross-origin `:3334`, launches Chrome with a temp profile, starts watcher `playground`. Pieces: `playground:serve`, `playground:chrome`, `playground:attach`.
- **Use**: smoke-test after `packages/argus` or `packages/argus-watcher` changes, e.g. `argus eval playground "..."`, `argus dom tree playground --selector "body"`.
- **Iframes**: same-origin `#playground-iframe` (3333) and cross-origin `#cross-origin-iframe` (3334) for target selection and in-frame eval (`argus ext select`, `--type iframe`).
- **Extend**: new commands/capabilities get matching controls in `playground/index.html`. Keep it self-contained (inline scripts, no build step).
- **Sourcemap fixtures**: never reformat `playground/sourcemapped-app.js`, `playground/inline-mapped-app.js`, `playground/maps/`, or `playground/src/`. Committed source maps encode exact line/column positions.

### Debug Cookbook

- **Watcher not found**: `argus list` → `argus doctor` → `argus watcher status <id>`.
- **Unreachable watcher**: check registry host/port; restart `argus watcher start ...`; verify `argus chrome start`.
- **CLI change not visible**: `npm run build:packages`.
- **CLI vs watcher mismatch**: rebuild, then `npm run test:playground`.

---

## Git / Release

- **Commits**: Conventional Commits (`feat|fix|refactor|build|ci|chore|docs|style|perf|test`), typed by user-visible intent. Header ≤120 chars, enforced by commitlint via `.husky/commit-msg`. Put nuance in the body.
- **Worktrees**: `~/dev/argus/` is a container; `argus/` is the primary checkout on `main`, feature worktrees are siblings. Managed with Worktrunk (`wt list`, `wt switch -c <branch> -y`, `wt merge`); run `wt` from inside a worktree. Hooks in `.config/wt.toml`: post-create copies `.env`, installs deps, builds packages; pre-merge runs `bun run typecheck`.
- **Merging**: `wt merge`'s fallback "Squash commits from …" message fails commitlint. Squash yourself, then let Worktrunk fast-forward: `base=$(git merge-base main HEAD) && git reset --soft "$base" && git add -A && git commit -m "feat: <summary>" && wt merge --no-commit -y`.
- **Plan files**: if a worktree was created from a plan file, delete it before merging (no confirmation needed).
- **Publishing**: before `npm publish`, check `npm view <pkg> version`. If the repo version already exists, bump and commit first.
- **Extension release asset**: `.github/workflows/release-extension.yml` attaches the extension zip when a GitHub release is published.

---

## Editing This File

Keep entries short, telegraphic, and verified against the repo (paths, scripts, symbols). Delete stale rules instead of annotating them.
