# Argus CLI reorg — discoverability for AI agents

Implementation plan: [cli-reorg-implementation.md](./cli-reorg-implementation.md).
Status: proposal. No backward compat. Target: an agent that has never seen Argus reads `argus --help` once and
gets every subsequent command right on the first try.

## What's wrong today (measured, not guessed)

Full tree dumped from the live Commander program: **41 top-level entries + 9 plugins**, ~190 leaf commands.

1. **Flat wall.** Verbs (`click fill hover drag keydown scroll-to reload goto screenshot record trace`) sit next to nouns
   (`dom net page chrome watcher storage`) in one unsorted list. No grouping in help output at all.
2. **Watcher id lives in four different slots.**
    - `argus logs [id]` — first positional, optional
    - `argus net show <request> [id]` — **last** positional (forced: optional-first + required-second can't parse)
    - `argus code read <url> --id app` — a flag
    - `argus page ls --id app` / `--cdp host:port` — flag, competing with a raw-CDP flag
    - `argus wb find <watcher> <request>` — plugins: required first positional
    - And the optional-id convenience is already broken for every two-positional command:
      `argus eval "document.title"` → _"Expression is required"_ because `document.title` was parsed as the id.
3. **Same thing, three doors.** `reload` × 3 (top, `watcher reload`, `page reload <targetId>` — the last one has
   _different_ semantics), `show/hide` × 3 (`page`, `watcher`, `ext`), `ls` × 4, `scroll-to` × 2, `goto` × 2,
   `eval --until/--interval/--count` vs `eval-until`.
4. **Interaction is split across levels.** `click drag hover fill keydown scroll-to` at top; `focus scroll set-file`
   under `dom`. An agent looking for "upload a file" has no reason to open `dom`.
5. **Groups named by implementation, not by question.** `auth` holds cookies (agent looks in `storage`); `throttle` is
   CPU only, while device emulation hides under `page emulation`; `snapshot` means a11y tree; `session` is a JSONL
   transport (collides with `storage session`); `ext` mixes install/setup with runtime iframe selection.
6. **Empty descriptions.** `code ls/read/grep/deminify/edit/strings`, `dom modify class/style/text/html`,
   all `storage local|session *` — blank in `--help`. Agents read exactly that text.
7. **Suggestions are level-local.** `argus dom click` → _"unknown command 'click'"_ with no pointer to `argus click`.
8. **No machine-readable manifest.** The only discovery channel is prose `--help` + SKILL.md.
9. **Semantic locators are a two-step.** `--role/--text/--label` exist only in `locate`; every action needs
   `locate … → ref → click --ref`. Playwright's `getByRole` is the #1 agent locator; here it costs a round-trip.
10. **Inconsistent verb vocabulary.** `remove|rm` vs `delete` vs `clear` vs `prune|clean`; `stop|kill|detach`;
    `ls|list|targets`; `export-state|export`, `load-state|load`.

## Design principles

- **Group by the question the agent is asking**, not by the CDP domain that answers it.
- **Match Playwright/MCP priors** for names: `click fill hover press goto back forward reload screenshot eval wait
snapshot`. LLMs already know these; zero-shot success is free.
- **Watcher is context, not payload.** The page you act on is ambient (like `gh`'s repo or `kubectl`'s context);
  the thing you act _with_ (selector, URL, expression) is the first positional. One exception, stated once:
  lifecycle verbs (`start stop status use`) take the watcher as their object.
- **One canonical path per capability.** Aliases allowed, shown as aliases, never as separate entries.
- **Same verb set everywhere:** `ls get set rm clear status start stop`.
- **Same element-targeting flags everywhere.**
- **Every leaf has a description and ≥1 example, enforced by a test.**
- **The CLI can describe itself to a machine.**

## 1. Watcher context: `-w` + `argus use`

Drop the positional `[id]` from every page-scoped command. Resolution order:

1. `-w, --watcher <id>` on the leaf (works before or after positionals — declared on each leaf by `defineCommand`,
   so `enablePositionalOptions` doesn't force it in front of the subcommand)
2. `ARGUS_WATCHER` env
3. `argus use <id>` — sticky default persisted in the registry, **keyed by cwd**. Survives fresh shells (agent
   harnesses persist cwd, not env). `argus start` and `argus attach` set it automatically for the cwd they run in.
4. Existing auto-resolve (single watcher in cwd → single reachable watcher)
5. Fail with candidates + the exact `argus use <id>` line to copy

```bash
argus start app --url localhost:3000     # also `use`s it for this cwd
argus eval "document.title"
argus click --role button --name Submit
argus net show req-12
argus -w other logs --since 5m           # explicit override
```

Every two-positional command becomes parseable (`fill <selector> <value>`, `storage local set <k> <v>`,
`net show <request>`), and plugins get `-w` for free through the shared option.

## 2. Target tree

Help groups via Commander 14 `helpGroup()`. Plugins render under their own **Plugins** heading instead of the
unlabeled tail. Internal commands (`watcher native-host`, `eval iframe-helper`) become hidden.

```
Session
  start [id] --url … --profile … --headless   Launch Chrome (CDP) + attach a watcher       [was start --id]
  attach [id] --url|--tab|--title            Attach to an existing tab (extension or CDP)  [was ext use/attach, watcher start]
  use [id]                                   Pin/show the default watcher for this cwd     [new]
  ls                                         Watchers + Chrome instances                   [was list]
  status [id]                                                                              [was watcher status]
  stop [id]                                                                                [was watcher stop]
  doctor [--watcher]                         Env + extension + one watcher, one command    [merge doctor + ext doctor]

Navigate
  goto <url>        back        forward        reload        url                           [page * flattened]
  page  show|hide|text                                                                     [text = tasks/page-text-extraction.md]
  tabs  ls|open <url>|close <tab>|activate <tab>                                           [was page ls/open/close/activate + ext tabs; source-agnostic]
  frame ls [--tree] | select --url|--title|--top | status                                  [was ext targets/select; source-agnostic]

Observe
  logs   [recent] | tail | cursor | epoch
  net    [recent] | tail | watch | summary | show | body | inspect | export | clear | ws | sse | mock add|ls|rm|clear
  dom    tree | info | snapshot | find | text?                                              [snapshot + locate move in]
  storage local|session|cookies  ls|get|set|rm|clear   +  cookies export                   [cookies out of auth]
  code   ls | read | grep | strings | deminify | edit                                       [+ descriptions]
  dialog status | accept | dismiss | prompt

Act
  click  drag  hover  fill  press  scroll  focus  upload                                    [press=keydown; scroll=dom scroll+scroll-to; upload=dom set-file]
  eval <expr> | --file | --stdin             Single shot                                    [drop --until/--count/--interval from eval]
  wait <expr>                                Poll until truthy                              [was eval-until; wait is canonical]
  run <scenario.ts>                          Bundled TS scenario                            [was eval --file --bundle]
  dom add | rm | set attr|class|style|text|html | script                                    [was dom add/remove/modify/add-script]
  auth export | import | clone <from> --to <to>                                             [was export-state/load-state]

Capture
  screenshot   record [start|stop|status]   trace [start|stop]

Emulate
  emulate device|viewport|ua|touch|cpu|clear|status                                         [was page emulation + throttle]

Infra
  chrome start|ls|status|version|stop        Raw CDP instance management
  ext    install|uninstall|status|path|info  Extension setup only
  config init|show|path     plugin ls|add|rm     serve [--reconnect]  [was session]     docs [topic] [--cat]  [was skill]
```

Top level shrinks from 41 to ~30 entries, but rendered as 8 labeled sections; every section answers one question.

### Naming decisions worth stating

- **Core interaction verbs stay top-level.** Nesting them under `input` would be tidier, but `argus click` is what
  every model guesses first. Discoverability comes from the **Act** help group, not from nesting.
- **`press`, not `keydown`.** Playwright name; and the command sends keyDown+keyUp anyway.
- **`wait`, not `eval-until`.** It's already the alias everyone uses. `eval` loses its polling flags — one command
  runs once, the other polls. `--interval/--count/--out --rotate` sampling moves to `wait --every 500ms --count 10`
  or a dedicated `sample` if that workflow matters.
- **`run`** makes the scenario runner first-class. "Write a script when primitives run out" is the natural agent
  fallback; today it hides behind `eval --file --bundle`.
- **`tabs` / `frame` are source-agnostic.** CDP targetId and extension tabId print side by side; `attach --tab`
  accepts either. Iframe selection stops being an extension-only concept (`start --type iframe` and `ext select`
  are the same intent).
- **`storage cookies`**, not `auth cookies`. `auth` shrinks to the three snapshot verbs.
- **`emulate`** absorbs `throttle` and `page emulation`; leaves room for `emulate network offline|slow-3g`.
- **`serve`**, not `session` — frees the word for `storage session` and browser sessions.
- **`docs`**, not `skill`: `argus docs` = SKILL.md path; `argus docs net --cat` prints the NET reference inline. The CLI
  ships its own manual and can hand it to an agent without a filesystem hunt.
- **Drop the `watcher` group.** Its verbs are the Session section. `watcher start --chrome-port` becomes
  `attach --cdp 127.0.0.1:9222`.

## 3. Unified element targeting

One vocabulary on **every** element command (`click drag hover fill press focus scroll upload screenshot dom
tree|info|find|add|rm|set`):

```
--selector <css>   --testid <id>   --ref <eN>
--role <role> [--name <text>]   --text <text>   --label <text>
--all   --nth <n>   --exact   --wait <duration>
```

`dom find` (was `locate role|text|label`) is the same flags returning refs, for the cases where you want to look
before you act. Actions accept them directly: `argus click --role button --name Submit` — no round-trip.
`--ref` today is missing from `dom tree/rm/add/set`, `screenshot`, `scroll-to`; it's on all of them afterwards.

## 4. Self-description for machines

- **`argus help --json`** (also `argus <cmd> --help --json`): full tree — canonical path, aliases, description,
  positionals, options with descriptions/defaults, examples, help group, `watcherScoped: true|false`. Generated from
  the Commander graph, so plugins are included and it can't drift. This is the single biggest discoverability win:
  an agent can load the manifest once and stop guessing.
- **`argus docs <topic> --cat`** prints reference files inline.
- **Tree-wide did-you-mean.** Unknown token at any level searches the whole tree by name and alias:
  `argus dom click` → _"did you mean `argus click`?"_; `argus locate` → _"moved: `argus dom find`"_. Keep a small
  `MOVED` table for one release so old SKILL.md snippets self-correct.
- **Structured hints in error envelopes.** `ok:false` JSON gains `hint: { command: "argus use app", why: … }` where
  human output already prints "Hint: run `argus list`". Agents parse JSON, not prose.
- **"See also" in help.** `dom find --help` → _See also: click, fill (accept the same flags and --ref)_.
- **Definition lint.** A unit test walks the tree and fails on: missing description, missing example, a leaf without
  `--json`, a watcher-scoped leaf without `-w`, a verb outside the canonical set without an alias to it.

## 5. Verb vocabulary (canonical → allowed aliases)

| Canonical         | Aliases  | Replaces                                                               |
| ----------------- | -------- | ---------------------------------------------------------------------- |
| `ls`              | `list`   | `targets`, `tabs`                                                      |
| `rm`              | `remove` | `delete`, `remove` (mixed today)                                       |
| `clear`           | —        | `prune`, `clean` (for registry: `argus ls --prune`)                    |
| `status`          | —        | `ping`, `info` (where it means the same)                               |
| `start`/`stop`    | —        | `attach`/`detach`/`kill`/`quit` (those become distinct commands or go) |
| `set`             | —        | `modify`, `add` (for attr/class/style)                                 |
| `export`/`import` | —        | `export-state`/`load-state`/`load`                                     |

## Migration sketch (order matters)

1. `defineCommand`: add `watcherScoped` → injects `-w`, resolves via `use`/env/cwd; add `helpGroup`, `seeAlso`.
   Add `argus use`. Delete positional `[id]` from every page-scoped definition. Plugin API: `defineWatcherCommand`
   drops the id positional. Update `sessionArgv` (it already derives argv from the tree; only the id injection changes).
2. Moves/renames per the tree above; `MOVED` table + tree-wide suggestions.
3. Unified targeting flags on all element commands; `locate` → `dom find`.
4. `help --json`, `docs --cat`, definition lint test, structured hints.
5. Rewrite `skill/argus/SKILL.md` + `reference/*` and README around the new grammar. Playground smoke + e2e.
6. Bump major. Publish.

Final checklist: run `npm run typecheck` and `npm run lint` after implementation; fix anything they report
(`npm run lint:fix` where safe).
