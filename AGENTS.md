## General rules

- **Keep files small**: Keep files under ~500 LOC so changes stay reviewable. If a file starts to sprawl, split it before adding more logic. Prefer extracting cohesive helpers/hooks/subcomponents over adding branching in-place.

- **Stable UI test IDs**: For app UI, add `data-testid` to _stable, large components_ (things tests/automation will target long-term). Use durable IDs; stable across copy/layout refactors. Don’t derive IDs from labels or DOM structure.

- **Writing style**: Direct; information-dense. Avoid filler, repetition, and long preambles (esp. in agent replies and “how-to” docs). Optimize for scanability: someone should find the rule fast and apply it correctly.

- **Adding rules**: When adding new rules/sections to `AGENTS.md`, keep them short and scannable. 3-5 sentences per bullet. Use the existing format: `##` section headers, bold-labeled bullets, and `---` separators between sections. Prefer telegraph style; add extra sentences only when they prevent misinterpretation.

- **Return early (guard clauses)**: Use guard clauses to handle error conditions and edge cases first. Return early to avoid deep nesting. Prefer multiple small guards over one large nested block.

- **Locality (order by call sequence)**: Declare functions/methods close to their callsites. Order them in call sequence (caller before callee) so readers can follow top-to-bottom. Keep helpers next to the primary method that uses them unless they’re widely reused.

- **Plans (implementation/refactor)**: When the user asks for an implementation or refactor plan, always end the plan with a short “final checklist”. It must explicitly say to run `npm run typecheck` and `npm run lint` after implementation, and to fix any errors found (use `npm run lint:fix` when appropriate). Keep this checklist to 1–2 short sentences.

- **Typechecking**: Use `npm run typecheck` for one-shot typechecking. Don’t use `typecheck-dev` for “quick checks” (watch mode).

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

- **Worktrees root**: Worktrees live as siblings under `~/dev/argus/` "container" directory.

- **Main checkout**: Primary working tree: `~/dev/argus/argus` (`main` branch). Treat it as the default base for tooling/scripts unless a worktree is mentioned.

- **Worktrunk (`wt`) CLI**: Manage worktrees via Worktrunk’s `wt` CLI: `https://github.com/max-sixty/worktrunk`. Use it to create/switch worktrees without manual branch/folder wiring.

- **Worktrunk workflow docs**: See `docs/workflows/git/git-worktrees.md`. Unsure which `wt` command fits: check docs before improvising. Keep examples aligned with the real repo layout.

- **Worktrunk common commands**: `wt list` (see worktrees), `wt switch -c <branch> -y` (create + switch), `wt merge` (merge back). Always sanity-check merge commit message before shipping.

- **Merging worktree**: Don’t let `wt merge` create the squash commit if it would fall back to “Squash commits from …” (commitlint will fail). Do the squash commit yourself, then let Worktrunk fast-forward without creating a commit. From the feature worktree run: `base=$(git merge-base master HEAD) && git reset --soft "$base" && git add -A && git commit -m "feat: <summary>" && wt merge --no-commit -y`. (Use `fix:`/`refactor:` etc. as appropriate.)

- **Plan files before merge**: If the worktree was created from a plan file (e.g. `tasks/*.md`), remove that file before running `wt merge`. Remove it without asking for confirmation.

---

## Logging

- **Log channels**: For app logging, use the channel-based logger from `src/renderer/logs/logs.ts` (import `logger`) and pick the channel that best matches the purpose via `logger.getOrCreate(<channel>)`. Channels are defined in `src/renderer/logs/LogChannel.ts`. Avoid raw `console.*` for non-trivial logging; it’s easy to lose context and harder to filter.

- **String-first logging**: Put the main information in a string so it survives into text logs reliably. If you need to log structured data, serialize it (e.g. JSON) into the message string (or include a short, string summary + a serialized payload). Don’t rely on logging raw objects as separate args for anything important.

- **Signal, not noise**: Add `info` logs around crucial transitions (open/save, persistence, cache invalidate, RPC boundaries) so flows are traceable, but keep volume low. Prefer one log per milestone with compact counts/ids over per-item spam. If a loop would log per node/asset/object, gate it behind debug or aggregate counts first.
