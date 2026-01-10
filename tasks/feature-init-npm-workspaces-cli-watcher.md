# Goal

Initialize Argus as a small **npm workspaces** monorepo with:

- A publishable **CLI package** (`argus`) that talks to local watcher HTTP servers.
- A **watcher library package** (not a CLI) that can be started by Node.js scripts and exposes the watcher HTTP API.
- A small shared core package for registry + protocol types.

CLI UX should follow the guidance in [clig.dev](https://clig.dev/) (help, errors, composability, consistency, robust exit codes).

---

# Current state

- Repo currently has **no** `package.json`, `tsconfig`, or source code.
- Repo may not yet be initialized as a git repository / GitHub repo.
- There is a design doc at `~/Downloads/argus-design.md` describing:
  - Registry discovery via `~/.argus/registry.json`
  - Watcher HTTP API (`/status`, `/logs`, `/tail`, optional `/clear` + `/stop`)
  - CLI commands (`list`, `logs`, `tail`) and output examples
  - Notes on reliability (Chrome restarts, tab disappearance, ring buffer)
- Updated constraints from answers:
  - CLI is published via **npm**
  - Runtime is **Node 20+**, **TypeScript**, **ESM**
  - CLI framework: **commander**
  - **No auth token at all** (drop `Authorization` header + token in registry)
  - Watchers are started via Node scripts → watcher is a **library**, not a CLI
  - No “spawn multiple watchers” orchestration command in the CLI
  - Registry cleanup can be “failed to connect now” and/or TTL-based
  - Tooling requirements:
    - Use **latest TypeScript**
    - Use **latest commander**
    - Set up **oxlint** and **prettier** with: no semicolons, single quotes, tabs with width 4, print width 150
    - Set up **commitlint** (Conventional Commits)
  - Git/worktree requirements (from `AGENTS.md`):
    - Main checkout lives at `~/dev/argus/argus` on `main`
    - Worktrees live as siblings under `~/dev/argus/`

---

# Proposed design

## Packages (npm workspaces)

Create:

- `packages/argus` (**CLI**)
  - Exposes `bin` entry `argus`
  - Commands: `list`, `logs`, `tail` (matching the design doc)
  - Talks directly to watcher HTTP servers discovered via registry.
- `packages/argus-watcher` (**library**)
  - Exposes a small API to start a watcher server from Node:
    - `startWatcher(options): Promise<{ close(): Promise<void> }>`
  - Handles CDP connection + target selection + log buffering + HTTP endpoints.
- `packages/argus-core` (**shared**)
  - Types: `LogEvent`, API response types, registry schema (v1)
  - Registry read/write helpers (atomic write strategy)
  - Optional small HTTP client helpers used by the CLI

Rationale: minimal packages for iteration speed; shared types live in `argus-core`.

## No-token security model

Since all watchers bind to `127.0.0.1`, remove:

- `Authorization` requirement on watcher endpoints
- `token` in registry entries

Guardrails:

- Watcher server should bind explicitly to `127.0.0.1` (not `0.0.0.0`).
- Consider a future-proofing hook (optional `auth` handler) but **don’t implement** it now unless needed.

## Registry file schema + cleanup

Keep the v1 registry structure but remove token:

- `~/.argus/registry.json` (macOS/Linux) / `%USERPROFILE%\.argus\registry.json` (Windows)
- `watchers[id] = { id, host, port, pid, startedAt, match, chrome }`

Atomic writes: write temp file then rename.

Cleanup strategy (combine both, as discussed):

- **Immediate reachability cleanup**: CLI removes an entry if it fails to connect during `list/logs/tail`.
- **TTL-based stale cleanup**: add `updatedAt` per watcher entry (or global + per watcher) and treat an entry as stale if `now - updatedAt > ttlMs`.
  - Default `ttlMs`: 60s (tunable via CLI flag later if needed).

Return-early style: registry reads should guard on “file missing / invalid JSON / wrong version” and return empty watcher list with a short warning to stderr.

## Watcher HTTP API (library-owned)

Implement endpoints per design doc:

- `GET /status`
- `GET /logs?after&limit&levels&grep&sinceTs`
- `GET /tail?after&timeoutMs&levels&grep`
- Optional: `POST /clear`, `POST /stop` (consider adding later; keep surface small initially)

API should be JSON; CLI should support both:

- Human output (default)
- `--json` (machine readable), per composability guidance in [clig.dev](https://clig.dev/)

## CLI UX guidelines (apply clig.dev)

Ensure:

- **Helpful `--help`** at every command level, with examples.
- **Errors to stderr**, normal output to stdout.
- **Exit codes**:
  - `0` success
  - `1` generic error / partial failure
  - Consider `2` for usage errors (invalid flags), consistent with many CLIs.
- **Non-interactive by default**; `tail` is long-running; provide clear way to stop (Ctrl+C).
- **Saying (just) enough**: quiet by default; add `--verbose` for debug info if needed later.
- **`--json` for automation**; keep JSON stable within a major version.

---

# Touch points (file-by-file)

## Repo root

- Git + GitHub + worktrees:
  - Initialize git repo (`git init`) and create/push GitHub repo using `gh` CLI.
  - Use Worktrunk (`wt`) for worktrees:
    - Keep the main checkout at `~/dev/argus/argus` on `main`
    - Create feature worktrees as siblings under `~/dev/argus/`
  - Ensure Worktrunk config exists/updated at `.config/wt.toml` (project local) as needed.
- `package.json`
  - Configure npm workspaces: `packages/*`
  - Add scripts:
    - `lint`, `lint:fix`
    - `typecheck` (for root app if created) + `typecheck:packages` (checks all packages)
    - `build` / `build:packages` (tsc build outputs)
    - `test` (optional; can be added once behavior exists)
- Tooling config files (root):
  - `prettier.config.cjs` (or `.prettierrc.json`) with:
    - `semi: false`
    - `singleQuote: true`
    - `useTabs: true`
    - `tabWidth: 4`
    - `printWidth: 150`
  - `.prettierignore`
  - `oxlint` configuration (e.g. `.oxlintrc.json` or `oxlint.json`) and npm scripts wired to it
  - `commitlint.config.cjs` using `@commitlint/config-conventional`
  - Git hook integration for commitlint:
    - Recommended: `husky` + `commit-msg` hook running `commitlint --edit "$1"`
    - Also add CI-friendly script (e.g. `commitlint:range`) for validating PR ranges
- `tsconfig.base.json` (shared compiler settings)
- `tsconfig.json` (project references)
- Root `README.md` with quickstart + how to run watcher library from a script

## Package docs

- `packages/argus/README.md` (install + usage + examples + `--json`)
- `packages/argus-watcher/README.md` (library API + example Node script)
- `packages/argus-core/README.md` (types + registry helpers; intended consumers)

## `packages/argus-core`

- `packages/argus-core/package.json`
- `packages/argus-core/src/index.ts`
- `packages/argus-core/src/protocol/*.ts`
  - `LogEvent` model + response types
- `packages/argus-core/src/registry/*.ts`
  - path resolution per platform
  - read/write/update helpers + atomic write

## `packages/argus-watcher` (library)

- `packages/argus-watcher/package.json`
- `packages/argus-watcher/src/index.ts`
  - `startWatcher(options)` public API with JSDoc (public API requirement)
- `packages/argus-watcher/src/cdp/*.ts`
  - connect/reconnect to Chrome CDP
  - find target by match (url/title substring or regex)
  - subscribe to `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`
- `packages/argus-watcher/src/buffer/*.ts`
  - ring buffer implementation (size configurable)
- `packages/argus-watcher/src/http/*.ts`
  - Node `http` server binding to `127.0.0.1`
  - request parsing w/ guard clauses (method/path validation)
  - JSON responses + error handling
- `packages/argus-watcher/src/registry/*.ts`
  - periodically refresh registry entry’s `updatedAt`
  - write-on-start + cleanup-on-stop

## `packages/argus` (CLI)

- `packages/argus/package.json` with `bin: { "argus": "./dist/bin.js" }`
- `packages/argus/src/bin.ts`
  - `commander` program + subcommands
  - consistent help text + examples
- `packages/argus/src/commands/list.ts`
- `packages/argus/src/commands/logs.ts`
- `packages/argus/src/commands/tail.ts`
- `packages/argus/src/output/*.ts`
  - human formatting (timestamps optional) and JSON formatting
- `packages/argus/src/httpClient.ts`
  - minimal Node `fetch` wrapper + timeouts + good errors

---

# Rollout order

1. Bootstrap git + GitHub repo + worktree workflow:
   - `git init`
   - Create the GitHub repo via `gh repo create ...` and set `origin`
   - Ensure default branch is `main`
   - Ensure Worktrunk (`wt`) is configured and feature worktrees are created as siblings under `~/dev/argus/`
2. Add root workspace scaffolding (`package.json`, tsconfigs, minimal tooling scripts).
   - Include prettier + oxlint + commitlint from day 1 so new files are consistently formatted and commits are enforceable.
3. Create `argus-core` with types + registry helpers (read/write/cleanup).
4. Create `argus-watcher` library:
   - ring buffer
   - HTTP server endpoints returning stubbed data first
   - registry announce/update/cleanup
5. Create `argus` CLI:
   - implement `list` against registry
   - implement `/status` calls
   - implement `logs` and `tail` with `--json`
6. Add CDP integration in watcher:
   - connect + attach + event capture
   - verify end-to-end tail flow

---

# Risks / edge cases

- **Registry corruption / concurrent writers**: must keep per-watcher updates isolated; use atomic rename; guard on JSON parse failures.
- **Stale watchers**: connectivity cleanup vs TTL cleanup; ensure CLI doesn’t delete entries too aggressively on transient errors.
- **No-auth model**: still safe if bound to `127.0.0.1`; accidental bind to all interfaces is the main risk → guard/validate bind host.
- **Tail long-poll**: ensure server returns promptly when logs exist; otherwise respects timeout; handle client retry loops and Ctrl+C cleanly.
- **CDP reconnection**: Chrome restarts; tab disappears; avoid tight retry loops (backoff).

---

# Testing notes

- **Manual smoke**:
  - Start Chrome with `--remote-debugging-port=9222`
  - Start watcher library from a small Node script (e.g. `node scripts/start-watcher.mjs`)
  - Run `argus list`
  - Trigger console logs in the matched tab; run `argus logs <id>` and `argus tail <id>`
- **Automation** (later):
  - Unit test ring buffer ordering + max size
  - Unit test registry read/write atomic behavior (temp file + rename)
  - Integration test HTTP API with Node `fetch`

---

# Final checklist

After implementation, run `npm run typecheck` and `npm run lint` and fix any errors found (use `npm run lint:fix` when appropriate).

