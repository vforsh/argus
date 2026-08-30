# Remaining code-quality work

Source: `CODE_QUALITY_AUDIT.md`. Everything the audit raised is closed except the items below and **C2**, which has its own plan in [`c2-frame-snapshot.md`](./c2-frame-snapshot.md) and is out of scope here.

Counts re-measured against the tree at `9040f1d`. Groups are independently shippable and ordered by value, not by audit id. Group 1 is a live defect; the rest is debt.

Gate for every group: `npm run typecheck`, `npm run lint` (`lint:fix` for the easy ones), `npm run test:playground`. Groups 1 and 5 touch the watcher — run `npm run test:e2e` before shipping those.

---

## 1. Sourcemap URL derivation · live bug · **do this first**

**Files:** [`packages/argus-watcher/src/sourcemaps/resolveLocation.ts:93`](../packages/argus-watcher/src/sourcemaps/resolveLocation.ts) (`fetchTraceMap`), cache at `:16-17`

`fetchTraceMap` does ``fetch(`${scriptUrl}.map`)``. It never reads the `//# sourceMappingURL=` comment the bundle carries, so the map location is a guess that only holds for the `app.js` → `app.js.map` convention with no query string. Verified failing in **both** CDP and extension mode against a live watcher, so it predates the recent pass.

Breaks for:

- **`app.js?v=abc123`** — the cache-busting query most production bundles ship with. It fetches `app.js?v=abc123.map`; a server that ignores unknown query params answers **200 with JavaScript**, `.json()` throws, and the `catch` caches `null`.
- Maps not at `<script>.map` — CDN-hosted, `/maps/…`, hashed map filenames.
- Inline `data:` sourcemaps.

Failure mode is silent and misleading: the log reports a plausible minified location rather than erroring. This is the feature C1 just extended to extension mode, so it currently pays off only for bundles that happen to match the guess.

**Fix:** stop guessing. `Debugger.scriptParsed` carries `sourceMapURL` per script — capture it where script events are already handled, resolve it against the script URL (may be absolute, relative, or a `data:` URI), and key the cache by script id rather than URL. Fold in **group 5's D16** while here: the cache is module-global, unbounded, and caches negatives forever, so today one bad derivation poisons that script for the whole watcher process.

**Verify:** a bundle served at `?v=…` reports original locations; a `data:` inline map resolves; a dev-server rebuild mid-session picks up the new map.

---

## 2. google-sheets: finish the command runner (B10 → D13)

**Files:** `packages/argus-plugin-google-sheets/src/` — runner already exists in `sheetCommandUtils.ts` (`runSheetCommand`)

Largest LOC win left, and entirely mechanical. **2 of 22** commands are on the runner (`runList`, `runInfo`); the other 20 still hand-roll the same `createOutput → validate → eval → json/human` pipeline:

| File                    | `run*` functions still off the runner                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `commands.ts`           | `runAdd` `runFind` `runMove` `runRead` `runRemove` `runRename` `runResolve` `runSelect` `runSwitch` |
| `mutationCommands.ts`   | `runBatch` `runBatchOperation` `runClear` `runWrite`                                                |
| `dimensionCommands.ts`  | `runAddDimension` `runDimensionMutation` `runRemoveDimension`                                       |
| `inspectionCommands.ts` | `runQuery` `runSchema`                                                                              |
| `applyCommands.ts`      | `runApply`                                                                                          |
| `diffCommands.ts`       | `runDiff`                                                                                           |

**D13 falls out of this and should land in the same pass.** 11 files write `process.exitCode` from library depth — worst are `dimensionCommands.ts` (8) and `mutationCommands.ts` (8), plus `sheetCommandUtils.ts` (5), `batchInput.ts` (4), `commands.ts` (4), and one or two each in `cliArgs.ts`, `gidTraversal.ts`, `typedMutationRuntime.ts`, `sheetRead.ts`, `diffCommands.ts`, `inspectionCommands.ts`. `setTypedRange` is a library function that sets `exitCode = 1` itself while its caller `executePlan` also throws — exit policy is smeared across the stack and any caller composing these helpers inherits the side effect.

Once every command routes through `runSheetCommand`, restrict `exitCode` writes to that one site and have the helpers return discriminated results. Also add a one-line comment at `evalInWatcher`'s `response.data.result as T` naming it the eval trust boundary.

**Do it in tranches by file** so each commit stays reviewable, `commands.ts` first (9 of the 20) — `runList`/`runInfo` there are the worked examples to copy.

---

## 3. Test-surface debt

Two separate problems; the second is cheap and should go first.

### 3a. `e2e/` is not typechecked

`npm run typecheck` covers the app, the packages, and the extension — not `e2e/`. Making `CdpSessionHandle.getTargetContext` required broke `e2e/record.test.ts`'s hand-written stub at **runtime**, in a suite that takes minutes, instead of at compile time.

Add an `e2e` project to the typecheck chain. Small, and it pays for itself the next time an interface moves.

### 3b. `e2e/` deep-imports package internals

21 distinct `../packages/*/src/*.js` paths. Export hygiene and the "public API must be documented" rule stay unenforced, and a green e2e run says nothing about the published surface. Densest:

| Import                                | Uses |
| ------------------------------------- | ---- |
| `argus/src/commands/evalShared.js`    | 3    |
| `argus-watcher/src/cdp/connection.js` | 3    |
| `argus/src/output/io.js`              | 2    |
| `argus-watcher/src/cdp/eval.js`       | 2    |
| 17 more                               | 1 ea |

Route each through the package's public entry point; where that means a symbol is genuinely not public, that is the finding — decide whether to export it (with JSDoc, per AGENTS.md) or restructure the test. Doing 3a first turns the remaining work into compile errors.

### 3c. sheets test-mirror modules

`boundedTraversal.ts` and `leaseModel.ts` exist only for `lease-deadline.test.ts`; the logic that ships lives in the page scripts. Deleting them removes a test that never covered shipping code. The honest fix is to test the real path, which needs a browser — so either delete with a note, or fold into the C2 harness once that exists.

---

## 4. D17 mechanical sweeps

Zero risk, no urgency, high line count. Each row is its own commit.

| Sweep                                               | Count | Canonical                                                                            |
| --------------------------------------------------- | ----- | ------------------------------------------------------------------------------------ |
| Inline `error instanceof Error ? … : String(error)` | 29    | `formatError` — now in argus-core, re-exported from `cli/parse.ts`                   |
| `--json` option literal in register files           | 69    | one shared `jsonOption` const (two files already invented their own)                 |
| Hand-rolled `{ ok: false, error: { … } }` in routes | 15    | add the missing general `respondApiError(res, status, code, message)` to `httpUtils` |
| `delay`/`sleep` one-liners                          | 14    | one shared helper                                                                    |
| `nextAfter` cursor computation across net routes    | 10    | one helper                                                                           |

Also still open from D17's table: the inline/`--file`/stdin input-source state machine (6 copies, `evalShared.ts` canonical), paginated watcher-fetch loops (4), `pickNumber`/`normalizeString`/`sanitizeUrl` duplicated between `networkCapture.ts` and `networkRealtimeCapture.ts`, console bypasses of the `Output` contract, and the paired shadow helpers / identity aliases.

`evalShared.ts` (475 LOC / five concerns, held under the line by re-export shims) belongs here too: move iframe wrapping to `evalIframe.ts` and the emitters to `evalEmit.ts`, then migrate importers off the shims.

---

## 5. Watcher internals · `MINOR`

- **D9** — `startWatcherRuntime.ts` is 417 LOC. The extension and cdp branches duplicate the full events-mapping object and all five service constructions, differing only in `pageSession` presence; `sourceHandle.pageSession ?? sourceHandle.session` repeats 8× across it and `runtime/watcherServices.ts`. Build `sourceHandle` per mode, then the service block once. Extract `createIndicatorBinding` and `createInjectOnAttach` next to `runtime/watcherInject.ts`, and collapse the four shutdown flags to a promise latch.
- **D10** — `editor.ts` (472 LOC) coordinates enable-once, quiet-period, listener-binding, and a resource registry through `enabled`/`enabling`/`listenersBound`/`settleTimer` in one closure. The `reset()` vs `rebind()` distinction (navigation vs re-attach) is real but only decipherable from the caller; `reset` deliberately keeps `enabled` true, which reads as a bug until you know CDP domains survive navigation. **Document the lifecycle before touching the logic** — most likely file in the watcher to break under a future edit.
- **D15** — `LogBuffer` runs two parallel long-poll subsystems (`waitForAfter`/`flushWaiters` and `waitForAfterEpoch`/`flushEpochWaiters`, both flushed at `:96-97`). The id-based path survives only as the `kind: 'all'` position query, expressible as "epoch at the start of the retained buffer". Also `getCursor()` → `beginLogEpoch()` ← `getEpoch()` are three names for one value (`:107-118`).
- **D16** — module-level mutable state without lifecycle. The sourcemap cache half is covered by **group 1**; separately, `native-messaging/session-manager.ts:37` keeps `let nextRequestId = 1` at module scope while `pendingRequests` is per-instance (`ControlSessionManager` keeps its counter per-instance), and the two session managers duplicate the pending-request machinery. Move the counter into the class and extract one `createPendingRequestTable(timeoutMessage)`.

---

## Not in scope

**C2** — see [`c2-frame-snapshot.md`](./c2-frame-snapshot.md). One note from live verification: a real extension watcher **was** driven end-to-end by hand during this pass, so C2's blocker is now specifically "nothing exercises iframe selection across a navigation", not "nothing exercises extension mode". The e2e harness that plan calls for is demonstrably buildable.
