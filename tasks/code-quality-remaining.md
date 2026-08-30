# Remaining code-quality work — closed

Source: `CODE_QUALITY_AUDIT.md`. Every group in this plan is done as of `4f02ef4` (19 commits from
`028f1e1`, +3079/−2401 across 204 files). **C2** was out of scope and remains the only open item;
see [`c2-frame-snapshot.md`](./c2-frame-snapshot.md).

Gate at the end of the pass: `npm run typecheck`, `npm run lint`, `npm run test:e2e` — all green
(114 unit tests + 25 e2e files, 0 failures).

Kept as a record because three groups landed differently than planned, and the reasons matter more
than the tick-boxes.

---

## 1. Sourcemap URL derivation · was a live bug · `ac7eca0`

Fixed, but **not** the way the plan said. The plan called for `Debugger.scriptParsed`'s
`sourceMapURL`. The watcher only enables `Debugger` lazily, for `argus code`; turning it on for every
attached page just to learn a URL is not worth the V8 deopt on a tool meant to observe. So the
bundle's own `//# sourceMappingURL=` annotation is read instead — fetched tail-first via a `Range`
request, resolved against the script URL, with inline `data:` maps decoded in place.

Reproduced before the change and verified after, against a live playground watcher: a bundle at
`?v=abc123` whose map lives at a hashed path under `/maps/` now reports original locations, as does
one with an inline map. `/sourcemapped-app.js?v=abc123.map` really does answer 200-with-JavaScript on
a static server, exactly as the audit predicted.

D16's cache half closed with it: the cache is a per-watcher instance threaded through both sources
(compile-enforced — there is no module-global fallback), LRU-bounded, TTL'd on negatives, and cleared
on navigation.

Playground gained the two fixtures and a smoke-test assertion on file **and line**; both bundles and
their maps are prettier-ignored, because reformatting them silently desyncs the mapping (it did,
once, mid-pass — `e12f820`).

---

## 2. google-sheets command runner · `d1f9191`

All 22 commands are on `runSheetCommand`, and `validate` now hands its parsed flags to `execute` so a
duration or count is parsed once instead of re-parsed behind a `!`.

D13 landed by a different route than "discriminated results": failures go through `failCommand`,
which records into a `withCommandExit` scope that `runSheetCommand` establishes and drains **once**.
That fixes the actual defect — `setTypedRange` mutating process-global state its callers inherited —
without rewriting ~15 helper signatures and ~60 call sites. 38 `process.exitCode` writes across 11
files became one writer.

**The plan's "largest LOC win left" was wrong.** A spec costs about what the boilerplate did, and
four hundred-line command bodies got split into named steps, so the net is roughly flat. The win is
uniformity and one exit-code writer, not line count.

---

## 3. Test surface · `52e1a5a`, `dc87852`, `a7a0dcc`

**3a** grew past its brief. Typechecking `e2e/` surfaced 25 errors, including the `getTargetContext`
stub the audit named. Then `packages/*/test` turned out to be neither typechecked _nor run by any npm
script_, with **seven tests failing at runtime** for the identical reason. One project
(`tsconfig.tests.json`) now covers `e2e/`, `packages/*/test`, and `playground/`; `npm run test:unit`
runs all four suites in ~4s and `test:e2e` runs it first.

**3b** done via a new `./internal` subpath on `@vforsh/argus` and `@vforsh/argus-watcher`. It is
explicitly not public API — CLI flag parsers and CDP plumbing should not become someone's dependency
— but routing through the export map makes the test-visible set a reviewed list in one file, and the
suites compile against emitted declarations instead of sources.

**3c** deleted. `boundedTraversal.ts`, `leaseModel.ts`, and `lease-deadline.test.ts` mirrored
invariants rather than shipping code (`leasePageScripts.ts` and `gidTraversal.ts`'s own deadline
loop), so the green test guaranteed nothing. The scenario a real test would need is recorded in the
C2 plan, which is where the browser harness is being built.

---

## 4. D17 mechanical sweeps · `0173277` → `c892f92`

| Sweep                        | Done                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| inline error-message ternary | 51 sites + 4 private re-implementations → argus-core `formatError`                       |
| `--json` option literal      | 64 sites + 2 private constants → `register/sharedOptions.ts`                             |
| hand-rolled error envelopes  | 15 route sites → `respondApiError`, which also types `code` for the first time           |
| `delay`/`sleep`              | 17 private one-liners → argus-core `time.ts`                                             |
| `nextAfter`                  | 5 route sites → `nextAfterCursor`; 2 CLI drain loops → `fetchAllNetPages`                |
| input-source state machine   | 4 hand-rolled copies → `commands/inputSource.ts`                                         |
| capture helper duplication   | `pickNumber`/`normalizeString` → `cdp/cdpValues.ts`; `sanitizeUrl` was an identity alias |
| console vs `Output`          | 20-odd sites → `usageError` / threaded `Output`                                          |
| `evalShared.ts`              | 475 → 354 LOC; iframe wrapping and emitters split out, re-export shims gone              |

Notes worth keeping:

- The route error envelopes were untyped (`code` was a bare string with no `satisfies ErrorResponse`),
  so a rename of an `ARGUS_ERROR_CODES` member would have left them compiling. That hole is closed.
- Four `console.*` sites stay deliberately: `bin.ts`, `cli/program.ts`, and the registry warning hook
  run before any command exists, and `watcher native-host` writes to stderr because **stdout is the
  native-messaging channel** — now commented so nobody "fixes" it.
- Two identity aliases survive on purpose, each with a stated reason in place:
  `parseCsv = parseCsvInPage` and `requestWatcherCommandAction = requestWatcherAction`. They are
  named facades across a module boundary, not shadow helpers.

---

## 5. Watcher internals · `63ea4e4` → `4f02ef4`

- **D9** — `startWatcherRuntime.ts` 417 → 291 LOC. `watcherServices` builds the source per mode then
  the five services once; the one real difference (only an extension session can be frame-scoped
  while a top-level session stays available) is stated where it lives. Indicator callbacks →
  `createIndicatorBinding`, attach-time injection → `createInjectOnAttach`, and the four shutdown
  flags → a promise latch that arms the teardown routine and runs it once.
- **D10** — documented, not refactored, exactly as the plan asked. `editor.ts` now explains what each
  flag means, why the enable is lazy, why 100ms of silence ends the resource replay, and what breaks
  if someone "fixes" `reset()` to clear `enabled`. No logic changed.
- **D15** — `LogBuffer`'s two long-poll subsystems are one. The id-based path only expressed the
  whole-buffer query, which is `epochAtStart()`. `getCursor`/`beginLogEpoch`/`getEpoch` → one name.
  **Behaviour note:** a cursorless long poll can now reject `log_epoch_evicted` if the ring buffer
  wraps past its anchor mid-wait. That needs more non-matching events than the buffer holds (50k by
  default) inside one poll window, and saying "your window is gone" beats a silently incomplete
  stream.
- **D16** — closed in two halves: the sourcemap cache with group 1, and the native-messaging counter
  here. Both managers use `createPendingRequestTable` + `createRequestIdAllocator`.

---

## Still open

**C2 only** — see [`c2-frame-snapshot.md`](./c2-frame-snapshot.md), whose start precondition (finish
this file first) is now met. Three things this pass hands it:

1. `tsconfig.tests.json` already covers `e2e/`, so the new extension harness is written under the
   compiler from the first line.
2. The import rule is set: harness code reaches packages through `./internal`, never `../src/`.
3. 3c's deleted lease/traversal mirrors are recorded there as a scenario the harness should cover.

Smaller things noticed in passing and deliberately not done — none of them audit findings:

- `e2e/watcher-dom.test.ts` (704), `e2e/playground-smoke.test.ts` (665), and `e2e/watcher-net.test.ts`
  (608) are over the ~500 LOC guideline. They are flat lists of independent cases, so splitting is
  mechanical whenever someone touches them.
- `argus-extension/src/background/service-worker.ts` (586) and `debugger-manager.ts` (572) are over
  too, but C2 rewrites both — leave them.
