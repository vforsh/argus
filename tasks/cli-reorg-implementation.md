# Argus CLI reorg — implementation plan

Companion to [cli-reorg.md](./cli-reorg.md) (the proposal: what and why). This file is the how: phases, files,
types, tests, done-criteria. No backward compat; everything lands on one branch (`wt switch -c cli-reorg -y`) as
one breaking release, committed per phase so each step is reviewable and revertable.

Phase order is deliberate: the guardrail test first (it polices every later move), the watcher-context change
second (it touches every definition once, so do it before moving them), tree moves third, then features that
only make sense on the final tree.

---

## Phase 0 — Guardrail: definition lint test

**Goal.** A unit test that walks the live Commander tree and fails on anything an agent would trip over. Written
first so Phases 1–5 can't regress descriptions/examples while shuffling ~190 leaves.

**Files.**

- `packages/argus/test/command-tree.test.ts` (new). Build the program the way `session-argv.test.ts` does
  (`createProgram({ mode: 'session' })` + `coreProgramRegistrars`), walk `program.commands` recursively, skip
  `help` and hidden commands.

**Rules (each its own `it`).**

- Every leaf and group has a non-empty `description()`.
- Every leaf has ≥ 1 example (read from the help text: `addHelpText('after', …)` → `command.helpInformation()`
  contains `Examples:`). Simpler: expose the definition list, not the Commander tree — export
  `coreCommandDefinitions` from `register/index.ts` and walk `ArgusCommandDefinition` directly. Do that.
- Every leaf declares `--json` (allow-list for the few that stream files: `screenshot`, `record`, `trace` still
  take `--json`; the exceptions today are `config init`, `auth export-cookies`, `auth export-state` — fix them
  instead of allow-listing).
- No two sibling commands share a name or alias.
- Verb whitelist for leaves: `ls get set rm clear status start stop show hide add find tree info read grep edit
export import clone install uninstall path open close activate select accept dismiss prompt tail cursor epoch
watch summary body inspect mock ws sse deminify strings snapshot text url goto back forward reload use attach
doctor init version prune` + top-level verbs. Anything else fails with "add to the whitelist or rename".
  The list is the contract; extending it is a conscious decision in a diff.
- After Phase 1: every `watcher: 'context'` leaf has `-w`; no leaf still declares an argument named `id`.
- After Phase 2: every top-level command has a `group`.

**Done when.** Test passes on the current tree with a temporary allow-list of the known-blank descriptions
(`code *`, `dom modify class|style|text|html`, `storage local|session *`); the allow-list is deleted in Phase 2.

---

## Phase 1 — Watcher is context: `-w`, `ARGUS_WATCHER`, `argus use`

### 1.1 Definition DSL

`packages/argus/src/cli/defineCommand.ts`

```ts
export type ArgusCommandDefinition = {
  …
  /**
   * 'context' — page-scoped: gets `-w, --watcher <id>`, resolved via flag → env → `argus use` → auto.
   * 'object'  — lifecycle verb whose positional IS the watcher (start/stop/status/use). No `-w`.
   * 'none'    — default; no watcher involvement (chrome ls, config init, docs).
   */
  watcher?: 'context' | 'object' | 'none'
  group?: string          // Phase 2
  hidden?: boolean        // Phase 2
  seeAlso?: readonly string[]  // Phase 4
}
```

- When `watcher === 'context'`, `defineCommand` pushes `{ flags: '-w, --watcher <id>', description: 'Watcher id
(default: ARGUS_WATCHER, then `argus use`, then the only watcher in this cwd)' }` **before** the definition's own
  options so it renders first in help.
- `createActionRunner` prepends the watcher id to the action args for `'context'` commands:
  `action(options.watcher, ...declaredArgs, mergedOptions, instance)`. This keeps every existing
  `run*(id, …args, options)` signature and every `action: async (id, options)` body untouched; the only edit per
  definition is `arguments: [{ flags: '[id]' … }]` → `watcher: 'context'`.
- `mergeCommandOptions` already gives the nearest declaring command ownership; `-w` is declared on the leaf, so
  `argus dom tree -w app` and `argus -w app dom tree` both resolve (the latter needs `-w` also on the root
  program — add it there as a plain option so the token is accepted; leaf wins when both typed).

### 1.2 Resolution order

`packages/argus/src/watchers/resolveWatcher.ts` — `resolveWatcher({ id })` becomes:

1. `id` (from `-w`) → registry lookup, `watcher_not_found` with candidates on miss.
2. `process.env.ARGUS_WATCHER` → same.
3. `readDefaultWatcher(process.cwd())` → if the id is no longer in the registry, drop the stale default
   (`clearDefaultWatcher(cwd)`) and continue; never silently fail on a dead default.
4. Existing auto-resolution (single watcher in cwd → single reachable watcher). Unchanged.
5. Failure: `watcher_required` + candidates + hint `argus use <id>` (see Phase 4.3 for the JSON shape).

New file `packages/argus/src/watchers/defaultWatcher.ts`:

```ts
// ~/.argus/defaults.json  (path via getArgusHomeDir(); ARGUS_HOME-aware, so e2e stays isolated)
type DefaultsFileV1 = { version: 1; byCwd: Record<string, { id: string; setAt: number }> }
export const readDefaultWatcher(cwd): Promise<string | null>
export const setDefaultWatcher(cwd, id): Promise<void>
export const clearDefaultWatcher(cwd): Promise<void>
```

Separate file, not the registry: the registry is rewritten by every watcher heartbeat and shared with the SDK;
a CLI-only preference doesn't belong under that lock or that schema. Keyed by absolute cwd (realpath'd) because
agent harnesses persist cwd across shells but not env.

### 1.3 `argus use`

`packages/argus/src/commands/use.ts` + registration in `quickAccessCommands.ts` (`watcher: 'object'`).

```
argus use <id>        # validate id exists in registry, persist for cwd, print "default watcher for <cwd>: app"
argus use             # print current default (or "none") + how it would resolve right now
argus use --clear
argus use --json      # { cwd, id, source: 'use'|'env'|'auto'|null }
```

`start` and `attach` call `setDefaultWatcher(cwd, id)` after the watcher registers unless `--no-use`. `stop <id>`
clears the default if it pointed at that id. `ls` marks the cwd default with `*`.

### 1.4 Positional cleanup

Every definition loses `[id]`; commands whose second positional was optional-only-because-of-id become
required: `eval [expression]` stays optional (`--file`/`--stdin` alternatives), `goto <url>` — no: `goto [url]`
stays optional (omit to rewrite params). `net show <request>`, `net body <request>`, `net inspect <pattern>`,
`fill [value]` (`--value*` alternatives), `storage local get <key>`, `auth cookies get <name>`,
`throttle set <rate>`, `dom set text <text>`, `code read <url>` (drop `--id`), `page ls/open/activate/close`
(drop `--id`; keep `--cdp` for raw endpoints — these become `tabs *`, Phase 2).

Rule to write into `AGENTS.md` (Repo Tour): **targeting is flags, payload is positional.** Add `-s` as the
short form of `--selector` everywhere it exists.

### 1.5 Session transport

`packages/argus/src/session/sessionArgv.ts`

- `takesWatcherId(command)` → `declaresOption(command, 'watcher')`; inject `'--watcher', watcherId` (after the
  path, before the tail) instead of a positional. Skip when the tail already carries `-w`/`--watcher`.
- `NON_SESSION_COMMANDS` and `STDIN_DASH_COMMANDS` get the new names in Phase 2 (`serve`, `attach`, `wait`).
- `packages/argus/test/session-argv.test.ts`: every expectation moves `'app'` → `'--watcher', 'app'`.

### 1.6 Plugin API

`packages/argus-plugin-api/src/index.ts`

- `ArgusWatcherCommandRunner<TArgs, TOptions>` → `(...rest: [...TArgs, TOptions]) => Promise<void>`; the runner
  reads `options.watcher`. `defineWatcherCommand` in `packages/argus/src/cli/defineWatcherCommand.ts` follows.
- Expose the declarative DSL to plugins: `ArgusPluginHostV1.defineCommands(parent: Command, defs:
ArgusCommandDefinition[])` (+ export the `ArgusCommandDefinition` type). Plugins then get `-w`, groups,
  examples, and Phase 4's manifest for free instead of hand-wiring `.argument('[id]')` (what
  `argus-clogs-plugin/src/commands.ts` does today). Hand-wired Commander registration stays allowed; the lint
  test only covers core.
- `ARGUS_PLUGIN_API_VERSION = 2`. `registerPlugins.ts` refuses `apiVersion: 1` modules with a message naming the
  migration doc.
- In-repo `packages/argus-plugin-google-sheets` migrates in this phase; the ten external `~/dev/argus-*-plugin`
  repos migrate in Phase 7 against the published API.

### 1.7 Tests

- e2e: ~250 argv literals carry a positional id (`grep -rhoE "'(eval|logs|click|…)'" e2e/*.ts`). Mechanical:
  most suites use a single watcher per test file, so set `ARGUS_WATCHER` in the spawned env (helpers already
  build `env` for `ARGUS_HOME`) and delete the positional. Where a test exercises two watchers, pass `-w`.
- New `e2e/watcher-context.test.ts`: `-w` beats env beats `use` beats auto; stale `use` default is dropped;
  `argus use` with no watchers fails with `watcher_required`; `start` sets the default; `stop` clears it.

**Done when.** `grep -rn "flags: '\[id\]'" packages/argus/src` is empty; `argus eval "document.title"` works
with one watcher and no flags; `npm run test:unit` + `test:e2e` green.

---

## Phase 2 — Tree moves, help groups, hidden, MOVED table, tree-wide did-you-mean

### 2.1 Help groups

Commander 14: `command.helpGroup(heading)`. `defineCommand` applies `definition.group`. Root help renders in
definition order within each heading, headings in first-seen order — so `register/index.ts` orders the arrays
Session → Navigate → Observe → Act → Capture → Emulate → Infra. `registerPlugins.ts` sets
`helpGroup('Plugins:')` on every command a plugin adds to the root (walk `program.commands` before/after the
plugin's `register` to find the new ones).

### 2.2 Hidden

`hidden: true` → `parent.command(name, { hidden: true })`. Apply to `native-host` (moves under `ext`),
`eval iframe-helper` (moves to `ext iframe-helper`), and the Phase 2.5 MOVED stubs.

### 2.3 Moves and renames

Register-file level: each bullet is one register file rewrite plus renaming the `run*` function's file only when
the domain changes (leave `commands/domClick.ts` as is; move `commands/throttle.ts` → `commands/emulateCpu.ts`).

| Old                                     | New                                                          | Notes                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------- | ---------------------------------------- | -------------------------------- | ----------------------------------------------- | ---------------- |
| `list`                                  | `ls` (alias `list`)                                          | Session                                                                                                                      |
| `start --id X`                          | `start [id]`                                                 | id positional, `watcher: 'object'`; sets `use` default                                                                       |
| `watcher start`                         | `attach --cdp <host:port> …`                                 | merged into `attach`                                                                                                         |
| `ext use`, `ext attach`                 | `attach --url/--tab/--title [--as id] [--frame-url …]`       | source auto: `--cdp` given or a registered Argus Chrome → CDP, else extension                                                |
| `watcher stop                           | status                                                       | ls                                                                                                                           | prune`                                                      | `stop`, `status`, `ls`, `ls --prune`     | top-level; `watcher` group deleted                                                                                                                                       |
| `watcher reload                         | show                                                         | hide`, `page reload <targetId>`                                                                                              | `reload`, `page show                                        | hide`                                    | one `reload`; the raw-target variant becomes `tabs reload <tab>`                                                                                                         |
| `doctor`, `ext doctor`                  | `doctor [-w id]`                                             | one command; extension section always included                                                                               |
| `page goto                              | back                                                         | forward                                                                                                                      | url`                                                        | `goto`, `back`, `forward`, `url`         | top-level, Navigate group                                                                                                                                                |
| `page ls                                | open                                                         | activate                                                                                                                     | close`+`ext tabs`                                           | `tabs ls                                 | open <url>                                                                                                                                                               | close <tab>                                                                                                            | activate <tab>                   | reload <tab>` | source-agnostic; rows carry `source: cdp | extension` and the right id kind |
| `ext targets                            | select`                                                      | `frame ls [--tree]`, `frame select --url                                                                                     | --title                                                     | --top`, `frame status`                   | source-agnostic wording; CDP watchers answer with their single target until CDP frame switching exists                                                                   |
| `page emulation set                     | clear                                                        | status`, `throttle set                                                                                                       | clear                                                       | status`                                  | `emulate device <preset>`, `emulate viewport <w>x<h> [--dpr] [--mobile] [--touch]`, `emulate ua <string>`, `emulate cpu <rate>`, `emulate status`, `emulate clear [--cpu | --device]`                                                                                                             | one status/clear for both routes |
| `locate role                            | text                                                         | label`                                                                                                                       | `dom find --role/--text/--label`                            | Phase 3 makes the flags universal        |
| `snapshot`                              | `dom snapshot` (top-level alias `snapshot` kept — MCP prior) |                                                                                                                              |
| `dom modify attr                        | class                                                        | style                                                                                                                        | text                                                        | html`                                    | `dom set attr                                                                                                                                                            | class                                                                                                                  | style                            | text          | html`                                    | descriptions added               |
| `dom remove`                            | `dom rm` (alias `remove`)                                    |                                                                                                                              |
| `dom add-script`                        | `dom script`                                                 |                                                                                                                              |
| `dom focus`, `dom set-file              | upload`, `dom scroll                                         | wheel`, `scroll-to`, `dom scroll-to`                                                                                         | `focus`, `upload`, `scroll [--by dx,dy                      | --to x,y                                 | --into-view]`                                                                                                                                                            | top-level Act; `scroll` unifies wheel input and scrollIntoView behind one command (`--wheel` forces real wheel events) |
| `keydown`                               | `press <key> [--code]`                                       | `<key>` accepts `Enter`, `Shift+Enter`, `Control+a`, `KeyG`; parser in `commands/domKeydown.ts` maps to the existing request |
| `eval-until`                            | `wait`                                                       | Phase 5                                                                                                                      |
| `auth cookies *`, `auth export-cookies` | `storage cookies ls                                          | get                                                                                                                          | set                                                         | rm                                       | clear`, `storage cookies export`                                                                                                                                         |                                                                                                                        |
| `auth export-state                      | load-state                                                   | clone`                                                                                                                       | `auth export`, `auth import`, `auth clone <from> --to <to>` |                                          |
| `storage local                          | session remove`                                              | `… rm`                                                                                                                       |                                                             |
| `net mock remove`                       | `net mock rm`                                                |                                                                                                                              |
| `session`                               | `serve`                                                      |                                                                                                                              |
| `skill`                                 | `docs [topic] [--cat]`                                       | Phase 4                                                                                                                      |
| `extension                              | ext install                                                  | setup                                                                                                                        | path                                                        | remove                                   | status                                                                                                                                                                   | info`                                                                                                                  | `ext install                     | uninstall     | path                                     | status                           | info` (`setup`folded into`install --host-only`) | setup-only group |
| `chrome ls                              | version                                                      | status                                                                                                                       | stop --id`                                                  | same, `--id` → `-w`                      | Infra                                                                                                                                                                    |
| `config init`                           | `config init                                                 | show                                                                                                                         | path`                                                       | `show` prints merged config with sources |

Deleted outright: `watcher` group, `locate` group, `throttle` group, `page emulation`, `eval iframe-helper` (→
`ext iframe-helper`, hidden), `ext show` (→ `page show` works on extension watchers already).

### 2.4 Descriptions

Fill every blank: `code ls/read/grep/strings/deminify/edit`, `dom set *`, `storage * *`. Delete the Phase 0
allow-list.

### 2.5 MOVED table + tree-wide did-you-mean

`packages/argus/src/cli/moved.ts`:

```ts
export const MOVED: Record<string, string> = {
  'locate role': 'dom find --role', 'locate text': 'dom find --text', 'locate label': 'dom find --label',
  'watcher start': 'attach', 'watcher stop': 'stop', 'watcher status': 'status', 'watcher ls': 'ls',
  'ext use': 'attach', 'ext select': 'frame select', 'ext targets': 'frame ls', 'ext tabs': 'tabs ls',
  'page goto': 'goto', 'page url': 'url', 'page ls': 'tabs ls', 'throttle set': 'emulate cpu',
  'eval-until': 'wait', 'keydown': 'press', 'scroll-to': 'scroll', 'dom set-file': 'upload',
  'auth cookies': 'storage cookies', 'session': 'serve', 'skill': 'docs', 'list': 'ls', …
}
```

`packages/argus/src/cli/program.ts`: in `exitProcess`/`throwOnExit`, on `commander.unknownCommand`:

1. Take the user's tokens up to and including the unknown one (from `process.argv`, or the argv handed to
   `parseAsync` in session mode — thread it through `createProgram`).
2. `MOVED[tokens.join(' ')]` (longest prefix first) → `error: "locate role" moved. Use: argus dom find --role`.
3. Else search the whole tree: exact name/alias match anywhere → `Did you mean: argus click …?`; else
   Levenshtein ≤ 2 over all leaf names → up to 3 suggestions with full paths.
4. Exit 2 as before. Session mode: same text in `session_unknown_command.message`.

Unit test `packages/argus/test/did-you-mean.test.ts`: `dom click` → `argus click`; `locate role` → moved
message; `logz` → `logs`; `net mok` → `net mock`.

### 2.6 Tests / docs touched in this phase

- Session: `NON_SESSION_COMMANDS = {'serve','start','attach','chrome start','ext native-host','logs tail',
'net tail','net sse'}`; `STDIN_DASH_COMMANDS = {'eval','wait'}`.
- e2e renames are grep-driven from the MOVED table (`for old in …; do grep -rl "'$old'" e2e; done`).
- `skill/argus/SKILL.md` gets a one-line note per moved command **in this phase** so the file never describes a
  tree that doesn't exist; the full rewrite is Phase 6.

**Done when.** `argus --help` shows 8 headings and ≤ 32 core entries; Phase 0 test passes with no allow-list;
`argus dom click` and `argus locate role` print the pointer; e2e green.

---

## Phase 3 — Unified element targeting

### 3.1 Protocol (`packages/argus-core/src/protocol/http/dom.ts`)

```ts
export type DomElementTarget = {
	selector?: string
	ref?: ElementRef
	role?: string // with optional `name`
	name?: string
	text?: string // hasText: filters selector/role matches; alone = getByText
	label?: string
	exact?: boolean
}
```

- `requireExactlyOneTarget` → `requireOneTargetKind`: exactly one of `selector | ref | role | label`, or `text`
  alone. `name` requires `role`; `exact` requires `role|text|label`.
- `domTargetPayload` composes the new readers from `schemaFields.ts`. Additive → no `ARGUS_PROTOCOL_VERSION`
  bump. `LocateRoleRequest` etc. and `/locate/*` routes are deleted in favour of `POST /dom/find` (below).

### 3.2 Watcher (`packages/argus-watcher/src/cdp/dom/selector.ts`)

`resolveElementTargets` gains a semantic branch: when `role|label` is set, or `text` without `selector`, call
the existing `locateByRole/Text/Label` (`cdp/locate.ts`) to get backend node ids, register refs through
`ctx.elementRefs`, and return the same `ResolvedElementTarget` shape (`target: { kind: 'role', value }`). With
`selector` + `text`, current behaviour (textContent filter) stays. `defineDomTargetRoute` and the hand-rolled
click/drag routes need no change beyond passing the new fields through.

New route `postDomFind.ts` (`endpoint: 'dom/find'`): body = `DomElementTarget & { all?, wait? }`, response =
today's `LocateResponse` (`matches`, `elements[]` with refs). Remove `locate/*` from `WATCHER_ENDPOINTS`.

### 3.3 CLI

`register/domCommandBuilder.ts` → rename `targetingOptions()` and make it the single source for every element
command (click, drag, hover, fill, press `--selector`, focus, scroll, upload, screenshot, `dom tree|info|find|
add|rm|set|script`):

```
-s, --selector <css>   --testid <id>   --ref <eN>
--role <role> [--name <text>]   --text <text>   --label <text>
--all   --nth <n>   --exact   --wait <duration>
```

`resolveTestId` keeps rewriting `--testid` into a selector. `--nth` is new: index into `allHandles` after
matching (today only `dom add --nth` has it). `dom find` is the `locate` code with the runner swapped to
`defineWatcherCommand` (its `--action` chaining is dropped: actions now take the same flags directly).

`argus-client`: `client.dom.find(target)`; the locate helpers are removed. JSDoc.

### 3.4 Tests

- `e2e/watcher-dom.test.ts`: `click --role button --name Submit`, `fill --label Email`, `dom tree --text
"Welcome"`, `--nth 2 --all` semantics, ambiguity error without `--all`.
- Unit (`packages/argus-watcher/test`): `requireOneTargetKind` matrix.
- Playground `index.html`: add labelled inputs and same-text duplicates so `--exact`/`--nth` are testable.

**Done when.** Every element command accepts the full flag set; `/locate/*` gone; SKILL's "Interaction" examples
work as written with role/label flags.

---

## Phase 4 — Machine self-description

### 4.1 `argus help [path...] --json`

Replace Commander's built-in help command (`program.helpCommand(false)`, then register our own `help`):

- No `--json` → `program.outputHelp()` / `sub.outputHelp()` as today.
- `--json` → walk from the named command (or root) and emit:

```ts
type CommandManifest = {
	path: string[]
	aliases: string[]
	group: string | null
	hidden: boolean
	description: string
	watcher: 'context' | 'object' | 'none'
	arguments: { name: string; required: boolean; variadic: boolean; description: string }[]
	options: {
		flags: string
		long: string | null
		short: string | null
		description: string
		takesValue: boolean
		required: boolean
		repeatable: boolean
		default?: unknown
	}[]
	examples: string[]
	seeAlso: string[]
}
type HelpManifest = { argus: string; protocolVersion: number; pluginApiVersion: number; commands: CommandManifest[] }
```

Everything comes from the Commander graph plus a `WeakMap<Command, ArgusCommandDefinition>` that `defineCommand`
fills (for `watcher`, `examples`, `seeAlso`, which Commander doesn't model). Plugins that used the DSL are
complete; hand-wired plugin commands appear with what Commander knows.

`e2e/help-manifest.test.ts`: manifest parses, every non-hidden leaf is present, `dom tree` shows `watcher:
'context'` and `-w`.

### 4.2 `argus docs [topic] [--cat]`

`commands/skill.ts` → `commands/docs.ts`. Topics = `skill` (SKILL.md) + lowercased basenames of
`skill/argus/reference/*.md` (`net`, `eval`, `capture`, …). No topic → list topics with one-line summaries (first
heading) and the SKILL path. `--cat` prints the file. Path resolution reuses what `skill` does today.

### 4.3 Structured hints in local failures

`packages/argus/src/watchers/requestWatcher.ts` (`writeRequestError`, `writeResolveError`): when `output.json`,
emit the standard envelope instead of stderr prose:

```json
{
	"ok": false,
	"error": {
		"code": "watcher_required",
		"message": "…",
		"hint": { "command": "argus use app", "reason": "two watchers in this cwd" },
		"candidates": [{ "id": "app", "cwd": "…", "source": "cdp" }]
	}
}
```

Add to `ARGUS_ERROR_CODES` (`argus-core/src/protocol/http/errors.ts`): `watcher_required`,
`watcher_not_found`, `watcher_ambiguous`, `watcher_unreachable`. `ErrorDetail` gains optional
`hint?: { command?: string; reason?: string }` — additive.

Human output keeps the prose but every hint names the exact next command (`argus ls`, `argus use <id>`,
`argus doctor`), not "see all watchers".

### 4.4 See-also

`seeAlso: ['click', 'fill']` on a definition → `addHelpText('after', 'See also: argus click, argus fill')`
and the manifest field. Wire: `dom find` ↔ actions; `snapshot` → `dom find`; `wait` ↔ `eval`; `attach` ↔
`start`, `tabs ls`; `frame select` → `attach --frame-url`; `net mock add` → `net ls`; `storage cookies` ↔
`auth export`.

**Done when.** `argus help --json | jq '.commands | length'` equals the lint test's leaf count; `argus eval 1`
with no watcher prints the JSON envelope under `--json`.

---

## Phase 5 — `eval` / `wait` / `run`

- `eval [expression]`: single shot, plus sampling (`--every <duration>` (was `--interval`), `--count`, `--out`,
  `--rotate`). Remove `--until` (that is `wait`). Keep `--file`, `--stdin`, `--arg/--args`, `--inject`,
  `--iframe*`, `--timeout` (per evaluation).
- `wait <expression>`: poll until truthy. `--timeout` = total budget (was `--total-timeout`), `--every` (was
  `--interval`), `--eval-timeout` (per attempt, was `--timeout`), `--count`, `--verbose`. Exit code 1 on budget
  exhaustion with `{ ok:false, error:{ code:'wait_timeout', lastValue } }` — new error code.
- `run <file.ts|.js> [--arg k=v]…`: the `eval --file --bundle` path with the scenario context, promoted.
  `--no-bundle` for plain files. `eval --bundle/--no-bundle` removed.

Files: `register/evalCommands.ts` (split into `evalCommands.ts`, `waitCommand.ts`, `runCommand.ts`),
`commands/evalUntil.ts` → `commands/wait.ts`, `commands/evalBundle.ts` → `commands/run.ts`. Tests:
`e2e/eval-*.test.ts` rename flags; new `e2e/run.test.ts` from the bundle cases.

---

## Phase 6 — Docs, playground, SKILL rewrite

- `skill/argus/SKILL.md`: rewrite around the grammar. Sections: Modes → `start`/`attach` → `use` → Inspect loop
  → Interact (targeting flags table) → Navigate → Capture → Troubleshooting (error code → next command table).
  Every example runs without a positional id. Keep it under ~250 lines; details go to references.
- `skill/argus/reference/*.md`: `INSPECT.md` splits into `DOM.md` (tree/info/find/snapshot/text) and
  `INTERACT.md` (click/fill/press/…); `START.md` gains `use`/`attach`; `EXTENSION.md` shrinks to setup +
  `frame`; `SESSION.md` → `SERVE.md`; add `EMULATE.md`. `argus docs` topic list follows the filenames.
- `README.md`: Fastest Path becomes `argus start app --url … ; argus logs ; argus eval "…"`.
- `AGENTS.md` (repo): update Repo Tour, Golden Paths ("New CLI command" → use the DSL with `watcher`, `group`,
  `examples`; the lint test will tell you what's missing), add the "targeting is flags, payload is positional"
  rule and the verb whitelist pointer.
- `playground/index.html`: controls for `emulate`, `frame`, `dom find`; `npm run test:playground` updated.

---

## Phase 7 — Plugins and release

- Publish `@vforsh/argus-plugin-api@2`. Migrate `~/dev/argus-*-plugin` (10 repos) to the DSL: each plugin's
  `commands.ts` becomes an `ArgusCommandDefinition[]` with `watcher: 'context'` and `group: 'Plugins:'`;
  `<watcher>`/`[id]` positionals removed. Update their skill docs (`marketplaces`, `argus-clogs` skills in
  `~/dev/agent-skills`) — grep for `argus (wb|oz|ym|ga|lm|sl|clogs|gemotest) [a-z]+ (extension|app|[a-z]+) ` patterns.
- Version: `@vforsh/argus` → **1.0.0**. The command grammar is the public API and this is the moment it stops
  moving; a 0.6 would signal "still churning". `argus-core`/`argus-watcher`/`argus-client` bump minor
  (protocol additive) — check `npm view` first per Release hygiene.
- `chore(release)` commit; CHANGELOG section "Command grammar 1.0" = the MOVED table.
- Delete `tasks/cli-reorg.md` and this file before `wt merge` (plan-file rule).

---

## Risks and decisions already made

- **`-w` vs positional.** Decided: `-w`. The optional positional is already broken for two-positional commands
  (`argus eval "expr"` misparses), and a per-cwd sticky default is the only thing that survives agent shells.
- **Top-level verbs stay.** `click/fill/press/goto/screenshot/eval/wait` are Playwright priors; nesting them buys
  tidiness at the cost of first-guess accuracy. Help groups give the tidiness.
- **`--text` semantics change.** Alone it becomes getByText (was: invalid without selector). With `--selector` it
  keeps filtering. Documented in the targeting table; no silent behaviour change for existing valid invocations.
- **Sessions/plugins hard-break.** Acceptable per the brief; the MOVED table + `apiVersion` refusal make failures
  loud and self-explaining.
- **CDP `frame select`** is a thin shim until CDP frame switching exists; it answers with the single attached
  target and `not_available` for anything else, so the vocabulary is stable before the capability is.

---

## Final checklist

Per phase: `npm run build:packages` (serial), `npm run typecheck`, `npm run lint` (`npm run lint:fix` for
auto-fixables), `npm run test:unit`; before merge: `npm run test:e2e` and `npm run test:e2e:extension` with a
real Chromium (a skipped extension run proves nothing). Fix everything they report; then update SKILL/README
if any example drifted.
