## Goal

Add a repo-local config file at `.argus/config.json` which can provide defaults for:

- `argus chrome start`
- `argus watcher start`

The config must have **two top-level sections**: `chrome` and `watcher` (with `start` sub-sections under each), and we must ship a **JSON Schema** to make authoring the config easy in editors.

Both `chrome start` and `watcher start` must accept `--config <path>`.

---

## Current state

- CLI is implemented with `commander` in `packages/argus/src/bin.ts`.
- Chrome start logic lives in `packages/argus/src/commands/chromeStart.ts` (`runChromeStart(options)`).
- Watcher start logic lives in `packages/argus/src/commands/watcherStart.ts` (`runWatcherStart(options)`).
- Today, `watcher start` requires `--id` and `--url` at the CLI level (`.requiredOption(...)`), so it cannot be satisfied by a config file.
- There is no existing JSON schema or config loading mechanism.

---

## Proposed design

### Config file location + discovery

- **Auto-discovery** (when `--config` omitted): search the following candidates in order, using the **first existing file**:
    1. `path.resolve(process.cwd(), '.argus/config.json')`
    2. `path.resolve(process.cwd(), 'argus.config.json')`
    3. `path.resolve(process.cwd(), 'argus/config.json')`
    - If none exist, behave exactly as today (no config).
- **Explicit path** (when `--config <path>` is provided):
    - Resolve `path` as:
        - absolute if already absolute
        - otherwise relative to `process.cwd()`
    - If the explicit file is missing/unreadable/invalid, treat as a **user error** and exit with code `2`.

### Config shape

Use the nested `start` shape (per your choice):

```json
{
	"$schema": "../schemas/argus.config.schema.json",
	"chrome": {
		"start": {
			"url": "http://localhost:3000",
			"watcherId": "app",
			"defaultProfile": false,
			"devTools": true,
			"devToolsPanel": "console"
		}
	},
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"chromeHost": "127.0.0.1",
			"chromePort": 9222,
			"artifacts": "./artifacts",
			"pageIndicator": true
		}
	}
}
```

Notes:

- `chrome.start.url` and `chrome.start.watcherId` are **mutually exclusive** (mirrors `--url` vs `--id`).
- Config does **not** carry output knobs like `--json` (per your choice).

### Path resolution rules

- `watcher.start.artifacts` should be resolved **relative to the config file’s directory** (not `process.cwd()`).
    - Example: if config is `/repo/.argus/config.json` and `artifacts` is `./artifacts`, resolve to `/repo/.argus/artifacts` (or decide to resolve to `/repo/artifacts` by using `../artifacts`; schema/docs should clarify this).
- CLI `--artifacts` should keep current behavior (resolve relative to `process.cwd()`), since it’s an explicit per-invocation override.

### Merge / precedence

- **CLI overrides config**.
- To make this work correctly with `commander` defaults (especially negated flags like `--no-page-indicator`), use `command.getOptionValueSource(<key>)` and only treat a CLI value as an override when the source is `'cli'`.

Pseudo-merge rule (per option key):

- if `source === 'cli'`: keep CLI value
- else if config provides value: use config value
- else: keep current defaults / existing behavior

### Validation strategy (runtime)

Add a small internal loader with guard clauses:

- Parse JSON with helpful error messages (include filename + a short “expected shape” hint).
- Validate only the fields we support:
    - types (string/boolean/number)
    - ports in `1..65535`
    - mutual exclusion of `chrome.start.url` and `chrome.start.watcherId`
- On validation failure: print a single concise message and set `process.exitCode = 2`.

Keep validation dependency-free (no new runtime deps).

---

## Touch points

### New files

- `/.argus/config.json`
    - Checked in as a starter config (can be minimal; use docs for commentary since JSON can’t comment).
- `/argus.config.json` (optional alternative starter)
    - Only add this if we want a top-level “single file” config checked in by default; otherwise just support it for discovery.
- `/argus/config.json` (optional alternative starter)
    - Same note as above; supported for discovery regardless.
- `/schemas/argus.config.schema.json`
    - JSON Schema for the config file, including docs strings and examples.
- `packages/argus/src/config/argusConfig.ts`
    - Types for the config (TS-only) and runtime loader/validator helpers:
        - `resolveArgusConfigPath({ cliPath, cwd })` (auto-discovery + explicit)
        - `loadArgusConfig(resolvedPath): { config: ArgusConfig; configDir: string }`
        - `getConfigStartDefaults(config)` to extract `chrome.start` / `watcher.start`
        - `merge*StartOptionsWithConfig(options, command, config)` helpers

### Modified files

- `packages/argus/src/bin.ts`
    - **Add** `--config <path>` to:
        - `argus chrome start`
        - `argus watcher start`
    - **Change** `watcher start` options:
        - switch `--id` and `--url` from `.requiredOption(...)` to `.option(...)`
        - enforce required-ness **after merging** config + CLI (so config can satisfy them)
    - In the `.action(...)` handlers:
        - resolve + load config (auto-discovery or explicit `--config`)
        - merge into the options object using `getOptionValueSource`
        - call `runChromeStart(mergedOptions)` / `runWatcherStart(mergedOptions)`
- `packages/argus/src/commands/watcherStart.ts`
    - Update `WatcherStartOptions` to accept `chromePort?: string | number` (already) and keep runtime parsing.
    - Keep the existing “required id/url” guard clauses, but they should now pass when values come from config.
    - Update artifacts handling:
        - if artifacts value came from config, it should already be resolved to an absolute path during merge
        - keep CLI `--artifacts` behavior unchanged
- `packages/argus/src/commands/chromeStart.ts`
    - No behavioral change besides now accepting option defaults via merged inputs.
- Docs
    - `packages/argus/README.md` and `skill/argus/SKILL.md`
        - add `--config <path>` usage for both `chrome start` and `watcher start`
        - add a short config example and mention auto-discovery: `.argus/config.json`, `argus.config.json`, `argus/config.json`

---

## Rollout order

1. Add schema file `schemas/argus.config.schema.json`.
2. Add starter config `.argus/config.json` referencing the schema via `"$schema"`.
3. Implement config loader + validator in `packages/argus/src/config/argusConfig.ts`.
4. Wire `--config` + default config loading into `chrome start` and `watcher start` actions in `packages/argus/src/bin.ts`.
5. Adjust `watcher start` to allow config-provided `id`/`url` (remove commander `.requiredOption` and rely on merged runtime guard clauses).
6. Update docs (`packages/argus/README.md`, `skill/argus/SKILL.md`).

---

## Risks / edge cases

- **Commander defaults vs config overrides**: `--no-page-indicator` produces a default `true`; must use `getOptionValueSource('pageIndicator')` so config can set `pageIndicator=false` when CLI flag is absent.
- **Mutually exclusive chrome startup URL sources**:
    - config can accidentally specify both `chrome.start.url` and `chrome.start.watcherId`
    - CLI can also set one while config sets the other
    - treat as a usage error (exit 2) with a clear message.
- **Port typing**: schema should accept both integer and numeric-string? Prefer integer in config, and keep strings for CLI (`--chrome-port`) as-is.
- **Artifacts resolution**: ensure config-relative resolution is consistent and documented to avoid surprises.

---

## Testing notes

- Add focused unit tests for config parsing/merging (Node’s built-in test runner) to cover:
    - default config missing -> no change in behavior
    - explicit `--config` missing -> exit 2
    - `pageIndicator=false` in config is honored when CLI does not specify `--no-page-indicator`
    - CLI overrides config when option source is `'cli'`
    - artifacts path resolves relative to config directory
    - mutual exclusion (`url` vs `watcherId`) errors
- Quick manual smoke:
    - `npx tsx packages/argus/src/bin.ts watcher start --config .argus/config.json`
    - `npx tsx packages/argus/src/bin.ts chrome start --config .argus/config.json --dev-tools-panel console`

---

## Final checklist

Run `npm run typecheck` and `npm run lint` (fix any issues; use `npm run lint:fix` when appropriate).
