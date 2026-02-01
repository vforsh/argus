## General rules

- **Keep files small**: Keep files under ~500 LOC so changes stay reviewable. If a file starts to sprawl, split it before adding more logic. Prefer extracting cohesive helpers/hooks/subcomponents over adding branching in-place.

- **Writing style**: Direct; information-dense. Avoid filler, repetition, and long preambles (esp. in agent replies and “how-to” docs). Optimize for scanability: someone should find the rule fast and apply it correctly.

- **Adding rules**: When adding new rules/sections to `AGENTS.md`, keep them short and scannable. 3-5 sentences per bullet. Use the existing format: `##` section headers, bold-labeled bullets, and `---` separators between sections. Prefer telegraph style; add extra sentences only when they prevent misinterpretation.

- **Return early (guard clauses)**: Use guard clauses to handle error conditions and edge cases first. Return early to avoid deep nesting. Prefer multiple small guards over one large nested block.

- **Locality (order by call sequence)**: Declare functions/methods close to their callsites. Order them in call sequence (caller before callee) so readers can follow top-to-bottom. Keep helpers next to the primary method that uses them unless they’re widely reused.

- **Plans (implementation/refactor)**: When the user asks for an implementation or refactor plan, always end the plan with a short “final checklist”. It must explicitly say to run `npm run typecheck` and `npm run lint` after implementation, and to fix any errors found (use `npm run lint:fix` when appropriate). Keep this checklist to 1–2 short sentences.

- **Typechecking**: Use `npm run typecheck` for one-shot typechecking. Don't use `typecheck-dev` for "quick checks" (watch mode).

- **Runtime & deps**: Bun is the runtime and package manager (`bun install`, `bun run`). Prefer Bun/Node built-ins over new deps. Add deps to the specific package that needs them, not root. Keep `argus-core` dependency-free.

- **Code formatting**: Prettier runs on pre-commit via lint-staged. Config: tabs, no semicolons, single quotes, 150-char line width. Write in repo style; the hook handles edge cases. Linter: `npm run lint` (oxlint). Use `npm run lint:fix` for auto-fixable issues.

- **Skill docs**: `skill/argus/SKILL.md` is the AI-facing cheat sheet for the CLI. When adding or changing a command, update SKILL.md to match. Keep examples minimal and behavior-focused. Advanced topics go in `skill/argus/reference/`.

---

## Workspace packages

- **Workspace packages (`packages/*`)**: `packages/` are npm workspaces. Root `npm run typecheck` only checks the app (`tsconfig.app.json`) and does **not** typecheck packages.

- **Rebuild + package typecheck**: If you change anything under `packages/`, rebuild and typecheck the affected package(s) before testing. Prefer the package-specific scripts (e.g. `npm run build:<PACKAGE_1>`, `npm run build:<PACKAGE_2>`, etc.`); use `npm run build:packages` only when multiple packages changed.

- **Public API must be documented (JSDoc)**: Any public API in `packages/*` (anything exported for consumption by other packages/apps) must have JSDoc. Document parameters, return values, and important invariants/edge cases so changes are safe to make later.

---

## Critical Thinking

- **Fix root cause**: Fix the underlying cause, not symptoms. Trace failures to the violated invariant/contract; correct it. Add guards/fallbacks only when product-required (not to hide bugs).

- **Unclear?**: Read more code until you understand the existing pattern + constraints. Still unclear: ask concise questions with a small set of options. Don’t guess across layers (UI + RPC + data model) at once.

- **Conflicts**: Call out the conflict; state the tradeoff (1–2 sentences). Prefer the safer path when uncertainty is high (esp. persistence/editor behavior/user data). If risk is real: propose a minimal, reversible first step.

- **Unrecognized changes**: Assume intentional/another agent; keep going; focus scope. If it affects your work (types/APIs/build), stop and ask before large rewrites. When in doubt: isolate your fix; don’t depend on speculative refactors.

- **Breadcrumbs**: Leave short notes about what changed + why (esp. non-obvious decisions). Mention key files/functions so someone can follow the trail. If you rejected an approach: leave a one-line reason to prevent rework.

---

## Git

- **Commits**: Conventional Commits only (`feat|fix|refactor|build|ci|chore|docs|style|perf|test`). Pick type by user-visible intent, not files touched. If there’s nuance: add a short “why” body.

- **Commit message length**: Keep the commit message header under 120 characters. This is enforced by `commitlint.config.mjs` to allow for descriptive headers while maintaining readability. If a header needs more detail, use the commit body.

- **Worktrees root**: Worktrees live as siblings under `~/dev/argus/` "container" directory.

- **Main checkout**: Primary working tree: `~/dev/argus/argus` (`main` branch). Treat it as the default base for tooling/scripts unless a worktree is mentioned.

- **Worktrunk (`wt`) CLI**: Manage worktrees via Worktrunk’s `wt` CLI: `https://github.com/max-sixty/worktrunk`. Use it to create/switch worktrees without manual branch/folder wiring.

- **Worktrunk workflow docs**: See `docs/workflows/git/git-worktrees.md`. Unsure which `wt` command fits: check docs before improvising. Keep examples aligned with the real repo layout.

- **Worktrunk common commands**: `wt list` (see worktrees), `wt switch -c <branch> -y` (create + switch), `wt merge` (merge back). Always sanity-check merge commit message before shipping.

- **Merging worktree**: Don’t let `wt merge` create the squash commit if it would fall back to “Squash commits from …” (commitlint will fail). Do the squash commit yourself, then let Worktrunk fast-forward without creating a commit. From the feature worktree run: `base=$(git merge-base master HEAD) && git reset --soft "$base" && git add -A && git commit -m "feat: <summary>" && wt merge --no-commit -y`. (Use `fix:`/`refactor:` etc. as appropriate.)

- **Plan files before merge**: If the worktree was created from a plan file (e.g. `tasks/*.md`), remove that file before running `wt merge`. Remove it without asking for confirmation.

---

## Playground

- **What it is**: `playground/` is a self-contained test harness for manually exercising all Argus CLI capabilities. It bundles an HTML page with console/network/DOM/storage/eval/iframe sections, an HTTP server with API stubs, and an orchestrator that wires up Chrome + watcher in one command.

- **Quick start**: `npm run playground` starts everything (server on `:3333`, cross-origin server on `:3334`, Chrome with temp profile, watcher `playground`). Run it in the background — it's a long-running process that must stay alive while you test CLI commands in the foreground. Individual pieces: `npm run playground:serve`, `playground:chrome`, `playground:attach`.

- **When to use**: Use the playground to smoke-test CLI commands after changes to `packages/argus/` or `packages/argus-watcher/`. The watcher ID is always `playground`, so commands look like `argus eval playground "..."`, `argus dom tree playground --selector "body"`, etc.

- **Cross-origin iframe**: The page includes both a same-origin iframe (`#playground-iframe`, port 3333) and a cross-origin iframe (`#cross-origin-iframe`, port 3334). Both embed the Argus iframe helper script, so `--iframe` eval works on either. Use this to verify postMessage-based eval across origins.

- **Extending**: When adding new Argus commands or capabilities, add matching controls/structure to `playground/index.html` so they can be tested interactively. Keep the HTML self-contained (inline scripts, no build step).

---

## Repo Tour (edit compass)

- **CLI entry**: `packages/argus/src/bin.ts` (register order) + `packages/argus/src/cli/register/*` (flags/help).
- **CLI commands**: `packages/argus/src/commands/*` (use `requestWatcherJson`).
- **Watcher API**: `packages/argus-watcher/src/http/routes/*` + `packages/argus-watcher/src/http/router.ts`.
- **Route helpers**: `packages/argus-watcher/src/http/httpUtils.ts` (body parsing + errors).
- **Protocol types**: `packages/argus-core/src/protocol/http/*` + `packages/argus-core/src/protocol/version.ts`.
- **Client SDK**: `packages/argus-client/src/client/createArgusClient.ts`.
- **Tests**: `e2e/*` + `playground/`.

---

## Debug Cookbook (1-liners)

- **Watcher not found**: `argus list` → `argus doctor` → `argus watcher status <id>`.
- **Unreachable watcher**: check registry host/port; restart `argus watcher start ...`; verify `argus chrome start`.
- **CLI change not visible**: `npm run build:packages`.
- **Weird CLI vs watcher mismatch**: rebuild + run `npm run test:playground`.

---

## Tests / Gate (exact commands)

- **Quick**: `npm run lint` + `npm run typecheck` + `npm run typecheck:packages`.
- **Focused**: `npm run test:playground`.
- **Full**: `npm run test:e2e`.

---

## Golden Paths (checklists)

- **New CLI command (no new watcher API)**: add to `register*.ts` → implement in `packages/argus/src/commands/*` → ensure `--json` → add/adjust `e2e/*` → update `skill/argus/SKILL.md`.
- **New watcher endpoint**: add types in `packages/argus-core/src/protocol/http/<domain>.ts` → add route in `packages/argus-watcher/src/http/routes/*` + wire in `packages/argus-watcher/src/http/router.ts` → call via `requestWatcherJson` (CLI) / `createArgusClient` (client) → `e2e/*` → SKILL + (if interactive) playground UI.
- **Protocol change rules**: additive-by-default; breaking => bump `ARGUS_PROTOCOL_VERSION`; keep `ok`/`error` shapes stable.

---

## Contracts / Invariants (don’t break these)

- **HTTP payload shape**: success `ok: true`; failure `ok: false` with `{ error: { message, code? } }` (see `packages/argus-core/src/protocol/http/errors.ts`).
- **Watcher route conventions**: GET vs POST, path naming, `extensionOnly` behavior in `packages/argus-watcher/src/http/router.ts`.
- **Body parsing gotcha**: `readJsonBody` returns `{}` on empty body; routes must validate required fields explicitly.
