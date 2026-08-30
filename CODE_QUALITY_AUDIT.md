# Argus Code Quality Audit

**Date:** 2026-08-28
**Scope:** full monorepo — 7 packages, ~57k LOC of TypeScript, plus `e2e/` and `playground/`
**Method:** 8 parallel review passes (one per package slice + one cross-package seam audit), findings verified against callers before reporting
**Severity:** `BLOCKER` = presumptive merge-stopper · `MAJOR` = real maintainability debt · `MINOR` = opportunistic

---

## Verdict

The codebase is **structurally healthy at its core**. The CLI's `defineCommand`/`defineWatcherCommand`/`domCommandBuilder` trio, the watcher's route spine (`defineJsonRoute`, `defineDomTargetRoute`, `netFilters`), the shared `CdpSessionHandle` implemented by both transports, and argus-core's HTTP protocol types are genuinely good architecture that consumers actually use (66 protocol imports across watcher routes, 67 across CLI commands — no wholesale re-declaration).

The debt is concentrated at the seams, and it has one systemic cause: **contracts are maintained by copying, not derivation.**

- The wire protocol between extension and watcher exists twice, byte-identical, in independently versioned packages.
- The popup protocol exists three times inside one TypeScript project.
- The client SDK hand-retypes 434 LOC of the protocol package.
- The CDP boundary is untyped, so ~90 call sites re-declare payload shapes with casts.
- The second-layer helpers that should exist (evaluate-in-page, route body validation, a plugin command runner, a page-expression builder) were each reinvented 5–18 times instead of once.

**Roughly 4–5k LOC can be deleted behavior-preserving**, and most future drift converts from a silent runtime surprise into a compile error along the way.

| Metric                             | Count |
| ---------------------------------- | ----- |
| Blockers                           | 3     |
| Major structural findings          | ~24   |
| LOC deletable, behavior-preserving | 4–5k  |
| Latent bugs found in passing       | 1     |

---

## Blockers

### B1 — Native-messaging protocol is a 257-line byte-identical copy across two independently versioned packages

**Files:** [`packages/argus-extension/src/types/messages.ts:1-257`](packages/argus-extension/src/types/messages.ts) ≡ [`packages/argus-watcher/src/native-messaging/types.ts:1-257`](packages/argus-watcher/src/native-messaging/types.ts) · partial third mirror in [`packages/argus-core/src/protocol/http/extension.ts`](packages/argus-core/src/protocol/http/extension.ts) · `TabActionResult` duplicated again in `control-bridge-session.ts:23` vs `control-session-manager.ts:18`

Every message type, `TabInfo`, `ControlDiagnostics`, `FrameSnapshot`, `NativeCookie`, and all six union types exist on both sides of the wire, identical except the header comment (verified by `diff`). There is no shared package, no codegen, and no CI check that they match. The two sides ship as separate npm versions (extension 0.1.1, watcher 0.3.1, released separately per `bf19320`), so a field added on one side and forgotten on the other compiles cleanly and fails only at runtime in a user's Chrome. `ControlDiagnostics` is mirrored a third time into argus-core (`ExtensionControlBridgeStatus`/`ExtensionTabBridgeStatus`/`ExtensionRecentEvent`), so one diagnostics change must land in three files. Two independent review passes surfaced this.

**Fix:** Move the wire types to `argus-core/src/protocol/native-messaging.ts`; the extension takes a devDep on `@vforsh/argus-core` (types are erased at bundle time, so the no-runtime-deps property survives esbuild). Delete one copy. Carry a protocol version constant in the `host_info` handshake so mismatched peers fail loudly instead of subtly. Minimum viable alternative if the dep is unacceptable: a CI identity check plus the handshake constant.

---

### B2 — `parseNetArgv`: a 135-line shadow argv parser that overrides Commander and must mirror every `net` flag forever

**Files:** [`packages/argus/src/cli/register/netCommands.ts:365-499`](packages/argus/src/cli/register/netCommands.ts) (`resolveCommandOptions`, `resolveNetMockAddOptions`, `parseNetArgv`, `toCamelCase`) · trigger at `netCommands.ts:163-165` (`enablePositionalOptions()`) · test coupling in `packages/argus/test/net-mock-cli.test.ts`

~135 LOC re-implement Commander's option parsing by scanning raw `process.argv`: 9 boolean flags via `argv.includes`, 15 value flags via `lastIndexOf`, 7 repeatable flags via a manual loop, plus a bespoke `toCamelCase`. The fallback is spread **after** `value.opts()`, so the shadow parser is authoritative and Commander's parsing of these flags is decorative — the unit test even asserts raw argv beating parsed opts. Every new `net` flag must be added in two places or it silently disappears. The shadow parser also has weaker semantics than Commander: `--flag=value` form unsupported, `--grep` values starting with `--` dropped. `resolveNetMockAddOptions` adds a third layer to un-array `method`/`status`/`resourceType` because the shadow parser conflated filter-flag and mock-flag shapes.

**Fix:** Root-cause the "flags silently dropped" symptom — almost certainly the `enablePositionalOptions()` call on `net`, added so a bare `argus net app --grep x` works — and fix it at registration: drop `enablePositionalOptions`, or normalize option retrieval once via `command.optsWithGlobals()` in the action wrapper (see M11). Then delete `parseNetArgv`, `resolveCommandOptions`, `toCamelCase`, and the array-flattening in `resolveNetMockAddOptions`. Guard with playground/e2e cases for `argus net app --grep x` and `argus net mock add … --scope selected`.

---

### B3 — The extension CLI command family runs its own error-handling civilization: 13 failure emitters, 6 `formatError` clones, 6 incompatible JSON error shapes

**Files:** `packages/argus/src/commands/extension/` — `tabWatcher.ts:349-386`, `attach.ts:140-185`, `show.ts:156-190`, `select.ts:70-102`, `tabs.ts:84-500`, `targets.ts:81` · private `formatError` copies in `doctor.ts:227`, `tabs.ts:116`, `tabSelection.ts:102`, `show.ts:192`, `targetSelection.ts:289`, `tabAttach.ts:146` (all identical to the canonical `cli/parse.ts:2`)

Six different machine-readable failure shapes coexist in one directory:

| Shape                           | Files                          |
| ------------------------------- | ------------------------------ |
| `{success, error:{message}}`    | `install.ts:73,176`            |
| `{success:false, error:string}` | `setup.ts:20,34,47`            |
| `{configured:false, error}`     | `status.ts:16`                 |
| `{error}`                       | `info.ts:16`                   |
| `{ok:false, error:{message}}`   | `extensionPath.ts`             |
| `{ok:false, error:string}`      | `tabWatcher.ts` `writeFailure` |

This directly violates the repo's own contract (`ok:false` with `{error:{message,code?}}`, per AGENTS.md and `argus-core/protocol/http/errors.ts`). The emitters have already drifted: `tabs.ts:84` `writeResolveFailure` is missing its `else` and writes JSON to stdout **and** human lines to stderr, unlike every sibling. `tabs.ts:63` re-declares a private `formatExtensionTabLine` although `tabSelection.ts:74` exports the identical function. The `getPlatform()` try/catch + emit boilerplate is copy-pasted 5× (`setup.ts:17`, `status.ts:13`, `remove.ts:13`, `info.ts:13`, `install.ts:33`).

**Fix:** One `extension/failures.ts` exporting a single `emitFailure(output, { error, exitCode, matches?, candidates?, formatMatch? })` that always emits the canonical envelope, plus one `getPlatformOrFail(output)`. Delete all 13 local emitters, the 6 `formatError` clones (import from `cli/parse.ts`), the duplicate `formatExtensionTabLine`, and normalize `success:`/`configured:` payloads to `ok:`. ~250 LOC and an entire drift class.

---

## Theme A — Contracts maintained by copying

Every finding here converts silent runtime drift into compile errors.

### A1 — argus-client hand-mirrors the protocol: a 434-LOC parallel type universe plus field-by-field response copying · `MAJOR`

**Files:** [`packages/argus-client/src/types.ts:111-349`](packages/argus-client/src/types.ts) · `client/methods/capture.ts:66-73,95,106,117-126` · mirrored sources in `argus-core/src/protocol/http/{eval,trace,screenshot,record,domInteraction,visibility,status,logs,net}.ts`

Nearly every `XxxOptions`/`XxxResult` pair is a hand-retyped copy of a core `XxxRequest`/`XxxResponse` — same fields, same JSDoc (the 15-line `jsonValue` transport essay exists verbatim in both `protocol/http/eval.ts:20-36` and `types.ts:300-321`), differing only by the dropped `ok: true`. The Options types **are** the wire payload — `page.ts`, `capture.ts`, `evalMethods.ts` pass `body: options` verbatim — yet TypeScript enforces no relationship, so drift compiles cleanly and any client-only option added later silently leaks onto the wire. Method bodies then exist mostly to strip `ok` by re-listing every field (`toRecordStopResult` is 8 lines of `x: data.x`). Each new endpoint costs an Options copy, a Result copy, a mapper, a watcherHandle entry, and an index export.

**Fix:** Derive, don't retype. One `type Result<T extends { ok: true }> = Omit<T, 'ok'>`; `RecordStopResult = Result<RecordStopResponse>`, etc. Options types alias the core Request types, with genuinely client-only additions (`LogsOptions.mode`, `EvalUntilOptions`) layered via `&`. Method bodies collapse to a generic `requestResult<T>`. Kills ~200 LOC and the "forgot to copy the new field" failure mode.

### A2 — Popup ↔ service-worker protocol triplicated inside one TS project, stringly typed at the seam · `MAJOR`

**Files:** [`packages/argus-extension/src/background/popup-protocol.ts:2-3`](packages/argus-extension/src/background/popup-protocol.ts) ("The popup mirrors these shapes in `src/popup/types.ts`; keep them in sync"), `:66-70` (`action: string`) · `popup/types.ts:1-45` (hand mirror) · `popup/popup.ts:9-33` (third ad-hoc copy), `:97-101` (unchecked `sendMessage<T>`)

Both sides compile in the same package and bundle from the same `src/`, yet the contract exists three times held together by a comment. Drift is already real: `PopupStatusPayload` carries `recentEvents` (popup copy omits it — the field is computed, capped, and shipped every 2s to a consumer that ignores it) and popup's `TabInfo` silently dropped `watcherId`. Because `action` is `string`, the service worker needs a runtime `requireTabId` throw (`service-worker.ts:236-242`) and a `default: Unknown action` branch (`:224-225`), and popup's `sendMessage<T>` lets any call site claim any response type.

**Fix:** One shared `popup-protocol.ts` imported by both sides (delete `popup/types.ts` and `popup.ts:9-33`), with `PopupActionMessage` as a discriminated union and a request→response type map driving a typed `sendPopupMessage`. `requireTabId` and the unknown-action branch become compile-time facts.

### A3 — `/targets` and attach/detach request bodies bypass argus-core entirely; the CLI re-guesses the shapes by hand · `MAJOR`

**Files:** [`packages/argus-watcher/src/http/routes/getTargets.ts:5-18`](packages/argus-watcher/src/http/routes/getTargets.ts) (returns `{ok:true, targets}` with no protocol type; payload shape is the watcher-internal `CdpSourceTarget`) · `routes/postAttach.ts:6` (body typed inline) · [`packages/argus/src/commands/extension/targetSelection.ts:4-30`](packages/argus/src/commands/extension/targetSelection.ts) (CLI hand-declares `ExtensionTarget`, `ExtensionTargetsResponse`)

Directly violates the repo's own Golden Path ("New watcher endpoint: add types in `argus-core/src/protocol/http/<domain>.ts` → …"). `protocol/http/extension.ts` types the neighboring routes but `/targets` and the attach/detach _request_ bodies escaped it. `targetReady` was recently added by editing both ends by hand with zero compiler help. `ExtensionTarget` optionalizes `attached`/`targetReady` on faith.

**Fix:** Add `ExtensionTargetSummary`, `ExtensionTargetsResponse`, `ExtensionAttachRequest`, `ExtensionDetachRequest` to `argus-core/src/protocol/http/extension.ts`; type the three routes against them; delete the CLI's local declarations.

### A4 — The GET half of the protocol has no types: three stringly query-param implementations, already divergent · `MAJOR`

**Files:** [`packages/argus/src/watchers/queryParams.ts`](packages/argus/src/watchers/queryParams.ts) (205 LOC) vs [`packages/argus-client/src/client/queryParams.ts`](packages/argus-client/src/client/queryParams.ts) (178 LOC) vs watcher parsers in `http/routes/getLogs.ts:21-42` and `netFilters.ts` · `packages/argus/src/time.ts` ≡ `packages/argus-client/src/time/parseDurationMs.ts`, third divergent copy at `argus-plugin-google-sheets/src/mutationCommands.ts:366-378`

argus-core types every POST body and every response, but the GET side (`after`, `sinceEpoch`, `limit`, `levels`, `match`, `matchCase`, `source`, `sinceTs`, `grep`, `ignoreHost`, `ignorePattern`, …) lives as untyped `params.set('…')` strings in two independent builders plus the watcher's parsers — three implementations of one contract. Realized drift: the CLI's `appendNetFilterParams` supports 11 net filters (`host/method/status/resourceType/mime/scope/frame/party/failedOnly/minDurationMs/minTransferBytes`), the client's `buildNetParams` supports 3, so the **SDK silently cannot express filters the protocol supports**. `normalizeMatch`/`normalizeMatchPatterns` are re-implemented near-identically. The sheets copy of `parseDurationMs` drops `h`/`d` units, so `"2h"` parses as invalid there.

**Fix:** Move `parseDurationMs` into argus-core and delete both copies today (5-minute win). Then give each GET endpoint a typed query shape in `protocol/http/*` with one shared serializer in core, consumed by CLI and client — deleting one of the two ~200-LOC builders outright and giving the watcher parser a type to conform to.

### A5 — plugin-api re-declares CLI internals field-for-field, bridged by an unchecked cast exactly where checking matters most · `MAJOR`

**Files:** [`packages/argus-plugin-api/src/index.ts:32-134`](packages/argus-plugin-api/src/index.ts) (`ArgusOutput`, `ArgusWatcherRequestInput/Success/Error/Result`, `ArgusWatcherCommandRequestPlan`, `ArgusWatcherCommandContext`, `ArgusWatcherCommandSpec`, `ArgusDefineWatcherCommand`) · duplicated from `argus/src/watchers/requestWatcher.ts:14-40`, `cli/defineWatcherCommand.ts:21-108`, `output/io.ts:19-27` · the cast: [`packages/argus/src/cli/plugins/pluginHost.ts:34`](packages/argus/src/cli/plugins/pluginHost.ts)

Six-plus types are re-declared by eyeball. Simple members of `ArgusPluginHostV1` get structural checking on return, but the most complex one — `defineWatcherCommand`, a higher-order generic — is force-cast, so the compiler is muted at the one seam where drift breaks every published plugin at runtime rather than build time. Additional leaks: `ArgusWatcherRequestError.exitCode` embeds CLI process semantics in a plain HTTP result type, and `ArgusWatcherRequestInput` vs `ArgusWatcherCommandRequestPlan` declare the same path/method/body/query/timeout shape twice in one 200-LOC file. `commander` is a runtime `dependency` although `index.ts:18` imports it type-only.

**Fix:** Invert the dependency: plugin-api becomes the source of truth. The CLI already depends on `@vforsh/argus-plugin-api` — delete the CLI's local `WatcherRequest*`/`WatcherCommand*` types and `Output` shape, import the `Argus*` types, and type `defineWatcherCommand`'s declaration as `ArgusDefineWatcherCommand` so the cast disappears. `ArgusWatcherCommandRequestPlan = Omit<ArgusWatcherRequestInput, 'id' | 'returnErrorResponse'>`. Move `commander` to peerDependencies. Revisit `exitCode` for v2.

### A6 — `ARGUS_PROTOCOL_VERSION` is broadcast but never checked by any consumer · `MAJOR`

**Files:** [`packages/argus-core/src/protocol/version.ts:2`](packages/argus-core/src/protocol/version.ts) · only producer: `argus-watcher/src/http/routes/getStatus.ts:27` · consumers: zero hits for `protocolVersion` in `packages/argus/src` or `packages/argus-client/src`

AGENTS.md's Golden Path makes the version bump the escape valve for breaking protocol changes. The watcher reports it in `/status`; nothing reads it, not even to warn. Since CLI and watcher are separate npm packages, a 0.3.1 CLI can drive a long-running watcher started by an older install — a bumped version would change nothing observable, and mismatched peers keep talking and fail with confusing per-command errors instead of one clear message.

**Fix:** Compare `status.protocolVersion` against the compiled-in constant in `resolveWatcher`/`createClientContext` (both already hit `/status` in several flows); hard-error on major mismatch with a "restart the watcher / update argus" hint; surface it in `argus doctor`.

### A7 — The `ok` envelope is inlined 71× and error codes are stringly · `MAJOR`

**Files:** every file in `packages/argus-core/src/protocol/http/` (`ok: true` × 71 across 21 files) · inline error detail `{message: string; code?: string} | null` re-declared at `netMock.ts:111,148`, `emulation.ts:47,60,75`, `throttle.ts:18,27,36` (this is exactly `ErrorResponse['error']` from `errors.ts:4-7`) · ~20 error-code literals scattered in watcher routes, matched by raw string in `argus/src/commands/netInspect.ts:153`

AGENTS.md declares the envelope a core invariant, but the invariant has no type-level home: it's a convention re-typed per response, with no `ApiResult<T> = Ok<T> | ErrorResponse` union anywhere — every consumer rebuilds `T | ErrorResponse` by hand. The error detail object is independently re-declared five times with naming drift (`error` vs `lastError`). `code?: string` gives zero checking, so the CLI's `body_not_available` match would survive a watcher-side rename silently.

**Fix:** In `errors.ts`: `ErrorDetail`, `Ok<T> = { ok: true } & T`, `ApiResult<T>`, and an `ArgusErrorCode` union built from the codes the watcher actually emits. Response types become `Ok<{…}>`. Additive and shape-preserving — no protocol bump.

---

## Theme B — The missing second layer

Good primitives exist; the shared vocabulary one level above them doesn't, so every feature file re-derives it.

### B4 — The CDP boundary is untyped: `sendAndWait` returns `unknown`, so ~90 call sites re-declare protocol shapes with casts · `MAJOR`

**Files:** [`packages/argus-watcher/src/cdp/connection.ts:5,25`](packages/argus-watcher/src/cdp/connection.ts) · representative cast sites: `networkCapture.ts:157-176,221-241`, `editor.ts:22-49`, `accessibility.ts:10-34`, `dom/selector.ts:10-16`, `eval.ts:19-30`, `recording.ts:231-234`, `tracing.ts:53-54`, `auth.ts:31-41`, `visualCapture.ts:143-145`, `mouse.ts:240-265`

All ~90 command call sites and ~30 event handlers inline-declare the CDP payload shape and cast. The same shapes are re-declared across files (`{object?: {objectId?: string}}` appears 8+ times; `DOM.describeNode` result shapes live in `dom/types.ts`, `accessibility.ts`, and inline). Nothing checks that a declared shape matches the method — a typo'd method or wrong cast compiles silently. Single largest source of noise in the watcher.

**Fix:** One `cdp/protocol.ts` with `CdpCommandMap` (method → params/result) and `CdpEventMap` (event → payload) covering only the ~40 methods and ~25 events actually used; make `sendAndWait<M>` and `onEvent<E>` generic. Both transports (`connection.ts` and `sources/extension-delegating-session.ts`) implement the same interface, so one change covers both. Also fix `CdpEventMeta.sessionId?: string | null` (both optional _and_ nullable) to `string | null`.

### B5 — Evaluate-in-page unwrapping reimplemented ~8× with divergent error behavior · `MAJOR`

**Files:** `cdp/auth.ts:353-399` (`inspectPageState`), `storage.ts:13-35`, `watcherEvents.ts:92-111`, `mouse.ts:217-225` (round-trips through in-page `JSON.stringify`, unlike the others), `visualCapture.ts:176-193`, `authState.ts:31-58`, `pageIndicator.ts:216-250` (three identical swallow-wrappers)

Each site casts the `Runtime.evaluate` payload, unwraps `result?.value`, and handles `exceptionDetails` its own way — throw in auth/storage, silently swallow in watcherEvents/pageIndicator, ignore entirely in mouse/visualCapture. The normalization line `exception?.description ?? text ?? '…'` is verbatim in `auth.ts:395` and `storage.ts:30`, with a third richer version in `eval.ts`. This divergence is where inconsistent error messages come from.

**Fix:** One `evaluateInPage<T>(session, expression, opts)` (throwing a normalized page-exception error) plus a `tryEvaluateInPage` best-effort variant. `pageIndicator`'s three private wrappers collapse to one-liners.

### B6 — `resolveNode → objectId → callFunctionOn` copy-pasted 8×; five DOM-mutation files are one program · `MAJOR`

**Files:** `cdp/text-filter.ts:11-20`, `dom/modify.ts:79-91`, `dom/remove.ts:31-43`, `dom/insert.ts:34-47`, `dom/fill.ts:50-61`, `mouse.ts:149-160,201-214,255-265` · plus `cdp/dom.ts:1-23` (pure re-export shim)

The identical 10-line block exists eight times. One level up, `dom/modify.ts`, `dom/remove.ts`, `dom/insert.ts`, `dom/fill.ts`, `dom/setFile.ts` are the same program — `DOM.enable → getDomRootId → resolveSelectorMatches → run one page function per node → return {allNodeIds, count}` — five files, five options types, five result types, differing only in the page-side function string.

**Fix:** Extract `callFunctionOnNode(session, handle, fnDecl, args)` (deletes 8 copies), then collapse the five mutation files into one `dom/mutate.ts` with a shared `mutateMatchedElements(session, baseOptions, pageFn)` driver — `buildModifyFunction` already proves the shape. Removes ~4 files, their duplicated types, and the `dom.ts` shim.

### B7 — Watcher POST validation: the schema mechanism exists, 2 of ~45 routes adopted it, ~450 LOC of `typeof`+cast validation grew instead · `MAJOR`

**Files:** [`packages/argus-watcher/src/http/routes/defineRoute.ts:51-66`](packages/argus-watcher/src/http/routes/defineRoute.ts) (`bodySchema` supported; `body = (parsedBody?.value ?? rawBody) as TBody`) · `http/httpUtils.ts:56-63` (`readJsonBody` returns `{} as T`) · hand validators in `routes/netMock.ts:44-162`, `authCookies.ts:21-129`, `postEmulation.ts:24-72`, `postRecord.ts:41-114`, `postDomAdd.ts:14-41`, `postDomScroll.ts:12-36`, `postDomScrollTo.ts:11-44`, `postDomKeydown.ts:10-35`, `postScreenshot.ts:13-50`, `postLocate.ts:8-41`, +10 more · only schemas in existence: `argus-core/src/protocol/http/domInteraction.ts:62,158`

`defineJsonRoute` already supports typed `bodySchema` with `formatProtocolValidationIssues`, but only `/dom/click` and `/dom/drag` use it. Every other POST route declares `TBody` as the trusted protocol type and re-proves it field-by-field with casts like `(payload as {action?: string}).action` and `(payload as {state: unknown}).state as EmulationState`. **The type parameter is a lie until `validate` runs** — which is exactly why the AGENTS.md "routes must validate required fields explicitly" contract exists: `readJsonBody`'s `{} as T` pushes the proof obligation into every route instead of the boundary. The validators are also where drift lives; each reinvents "non-empty string", "non-negative integer", "boolean or absent".

**Fix (the judo move):** Make schema parsing the only path for POST bodies. Write `ProtocolSchema` validators in `argus-core/src/protocol/http/<domain>.ts` for the remaining request types (mechanical translations of the existing validate closures), change `defineJsonRoute` so `TBody` is only inferrable from `bodySchema`, and delete the `parseBody: true` + `validate` escape hatch (keep `validate` only for genuinely cross-field rules). Deletes ~450 LOC of route-level checks and all the casts inside them, moves validation to the layer AGENTS.md says owns protocol shapes, and **retires the documented `readJsonBody` gotcha** (empty body simply fails schema parse with a real message).

Related: argus-core carries a _second_, throw-based validation microframework (`auth/state.ts:189-249` — `expectRecord`, `expectString`, …) used only by `parseAuthStateSnapshot`. Two frameworks for the same job with incompatible error models. Fold it onto `ProtocolSchema` and move the shared field primitives out of `domInteraction.ts` (which is otherwise a pure type layer carrying ~150 LOC of validator implementation).

### B8 — `defineCommand`'s `any[]` action contract bred three incompatible Commander workarounds · `MAJOR`

**Files:** [`packages/argus/src/cli/defineCommand.ts:9,21`](packages/argus/src/cli/defineCommand.ts) (`parser?: (value, previous: any) => any`, `action?: (...args: any[]) => …`) · `register/recordCommands.ts:72-94` ≡ `register/traceCommands.ts:55-77` (`resolveActionOptions` copied verbatim, JSDoc included) · `register/logsCommands.ts:57,67,90` (`command.optsWithGlobals?.() ?? options`) · `parseNetArgv` (B2) is the third family

Because `action` is untyped, no register file trusts what Commander delivers, so each invented its own defensive normalization for "options might be the Command instance / parent opts might be missing". Same uncertainty, three incompatible solutions — and 30+ other actions do nothing at all, so the treatment is inconsistent across the surface. The `any` boundary also means every option object flows into typed `run*` functions as untyped spread, which is what let B2's drift hide.

**Fix:** Make `defineCommand` own the normalization once: wrap `definition.action` so the runner always receives `(...declaredArgs, optsWithGlobals, command)` with parent opts merged. Deletes both `resolveActionOptions` copies (~46 LOC), the three `optsWithGlobals?.()` hacks, and the soil `parseNetArgv` grew in. Tighten `action?: (...args: unknown[])` so new commands don't inherit the hole.

### B9 — `defineWatcherCommand` gives `formatHuman` no access to what `build` computed · `MAJOR`

**Files:** [`packages/argus/src/cli/defineWatcherCommand.ts:57-108`](packages/argus/src/cli/defineWatcherCommand.ts) (context carries only `output/watcher/args/options`) · `commands/pageEmulation.ts:31` (`buildEmulationState(options)!` re-run in `formatHuman`; the helper takes `output?: Output` solely so the second call can skip warnings) · `commands/domDrag.ts:63-77`, `domClick.ts:63-77`, `domScroll.ts:91-107` (`parseXY(options.by!)!` re-parse) · `throttle.ts:31` (`Number(args[0])` re-parse) · `domAdd.ts:29` · `domModify.ts:35-66`

Because `build`'s derived values are discarded, every non-trivial command re-derives them in `formatHuman` with non-null assertions, or abuses the `TArgs` tuple — which the type declares as _positional CLI arguments_ — to smuggle payloads and callbacks: `domModify` passes `[payload, successMessage]` and calls `args[1](successResp)`.

**Fix:** Let `build` return `{ plan, render?: (response, ctx) => void }` or add a typed `meta` slot on `WatcherRequestPlan` handed to `formatHuman`. One mechanism change deletes the recompute-and-assert pattern across ~7 files, drops `pageEmulation`'s dual-mode `output?:` param, and lets `domModify` delete `executeModify` and the args-tuple lie.

### B10 — google-sheets: 18 `run*` functions hand-roll the same pipeline, with quantified utility copy-paste · `MAJOR`

**Files:** `argus-plugin-google-sheets/src/commands.ts:203-471`, `applyCommands.ts:57-102,353-369`, `inspectionCommands.ts:65-202`, `diffCommands.ts:45-211`, `dimensionCommands.ts:87-159,295-298`, `mutationCommands.ts:104-198,448-458`

Every command follows the identical pipeline — `createOutput` → validate flags (warn + `exitCode = 2` + return null) → `withSheetLease`/`evalInWatcher` → `if (options.json) writeJson else writeHuman` — reimplemented 18 times. The utilities are literally copy-pasted: `usageError` ×4, `runtimeError` ×3, a positive-integer parser ×4 under **three different names** (`parsePositiveInt`, `positiveInteger`, `parsePositiveInteger`), `readStdin` ×2 (11 LOC each). ~130 LOC of pure duplicates.

**Fix:** A plugin-local `runSheetCommand(spec)` runner in `sheetCommandUtils.ts` mirroring `defineWatcherCommand`'s spec shape (`validate` → `execute(lease)` → `formatHuman`/`formatJson`), plus one `cliArgs.ts` holding the single copies of `usageError`/`runtimeError`/`parsePositiveInt`/`parseDurationMs`/`readStdin`. Every command added before this lands becomes copy #19. Longer term, an eval-command spec belongs in the plugin host itself.

### B11 — google-sheets page scripts: every file re-solves serialization · `MAJOR`

**Files:** `dimensionPageScripts.ts:154-191` vs `sheetDataPageScripts.ts:103-133` vs `pageScripts.ts:242-337` vs `leasePageScripts.ts:119-153` (`getSpreadsheetId`, `isRenderedElement` ×3, `pressElement` ×3, `delay`, `getRenderedElements`, `findRenderedElement`) · `csv.ts:2-45` vs `sheetDataPageScripts.ts:65-95` (identical ~45-LOC CSV parser ×2) · `a1.ts` vs `pageA1.ts` vs `mutationPageScripts.ts:169-194` (A1 parsing/offset ×3)

Because page expressions are built by concatenating `fn.toString()`, every embedded function must be self-contained — but the files satisfy this inconsistently: some import shared serializable helpers and list them in a deps array, others re-declare private copies. The copies agree today only by discipline, and a missing helper in a deps list is a runtime `ReferenceError` in the page with no compile-time signal. The expression builders themselves are 5 near-identical IIFE templates.

**Fix:** One `buildPageExpression(entry, input, deps)` utility; each page-helper module exports its own transitive dep list (`export const sheetDomDeps = [...]`) so builders compose instead of hand-picking. Consolidate on the serializable versions: `parseCsvInPage` becomes the single CSV parser (node side re-exports), lease/dimension copies import from `sheetDataPageScripts`, `mutationPageScripts`' A1 bounds logic collapses into `pageA1.ts`. ~150–200 LOC and the whole drift class. Keeping strict `a1.ts` separate from loose `pageA1.ts` is defensible but deserves a one-line breadcrumb in each — today nothing explains why two A1 modules exist.

**Cross-package note:** plugin-api exposes only raw expression strings (`ArgusBrowserHelpers.eval`), so the next plugin (`yagames` is already name-checked in `config/types.ts:40`) will reinvent this again. Consider promoting `buildPageExpression` into `argus-plugin-api`.

---

## Theme C — Dual implementations with realized divergence

Not hypothetical drift — these copies have already forked behavior.

### C1 — Extension mode silently reimplements the log-event pipeline and lost sourcemaps doing it · `MAJOR`

**Files:** [`packages/argus-watcher/src/sources/extension-log-events.ts:9-144`](packages/argus-watcher/src/sources/extension-log-events.ts) vs [`packages/argus-watcher/src/cdp/watcherEvents.ts:23-218`](packages/argus-watcher/src/cdp/watcherEvents.ts) · also duplicates `cdp/selectBestFrame.ts:16-45` and `cdp/locationCleanup.ts`

A from-scratch rewrite of the `Runtime.consoleAPICalled`/`exceptionThrown` → `LogEvent` mapping, with its own `normalizeLevel` (different semantics: `assert`→`error`, `table`/`dir`→`log`), its own `formatArgs` (raw `arg.value`, no remote-object serialization), its own synchronous `selectBestFrame`, and its own `applyStripPrefixes`. Crucially the copy **never calls `resolveSourcemappedLocation`** — extension-mode watchers get unmapped minified locations while CDP-mode watchers get sourcemapped ones. A user-visible behavioral fork that exists only because the mapping was copy-pasted.

**Fix:** Extract one source-agnostic `toLogEvent(params, pageInfo, config)` (the CDP one is already nearly source-agnostic — it needs a `CallFrame[]` and an optional serialization client) and delete the extension copy's four private helpers (~130 LOC). Extension mode passes its session handle for serialization or opts out explicitly.

### C2 — Both ends of the extension bridge maintain their own frame tree, glued by forged CDP events · `MAJOR`

**Files:** [`packages/argus-extension/src/background/debugger-manager.ts:344-419`](packages/argus-extension/src/background/debugger-manager.ts) (`refreshFrameTree`/`mergeFrameTree`/`pruneMissingSessionFrames`; synthetic `Page.frameNavigated` at :386-398, synthetic `Page.frameDetached` at :417 and :556) · [`packages/argus-watcher/src/sources/extension-session-events.ts:70-128`](packages/argus-watcher/src/sources/extension-session-events.ts) (rebuilds the same tree from those events) · `sources/extension-frame-runtime.ts:107` (watcher _also_ calls `Page.getFrameTree` itself)

Both ends parse `Page.getFrameTree` into a frames map + topFrameId, and the extension **fabricates** navigation/detach events during snapshot merges so the watcher's incremental copy stays fresh. Forged events travel as `cdp_event` messages indistinguishable from real Chrome events, so watcher handlers (navigation callbacks, `onPageNavigation`, title refresh) fire for synthetic traffic — every 150ms-debounced sync replays a `frameNavigated` for _every_ frame. Triple bookkeeping for one piece of state, and it is precisely the terrain the recent target-recovery fix (`f4c449f`) had to thread through.

**Fix (highest-leverage redesign in the extension):** The extension already owns the authoritative tree and already ships a snapshot in `tab_attached.frames`. Add one `frame_snapshot` bridge message emitted from `replaceFrameTreeSnapshot`, consumed by the watcher via the existing `seedExtensionFrameState` path. Deletes the event forging in three functions, the watcher's own `Page.getFrameTree` polling in frame-runtime _and_ `extension-target-recovery.ts` (recovery becomes "wait for the next snapshot"), and most of the incremental reconstruction. Shrinks `debugger-manager.ts` (572 LOC) by ~40%.

### C3 — CLI and SDK unwrap the same envelope with different side effects · `MAJOR`

**Files:** [`packages/argus/src/watchers/requestWatcher.ts:133-156`](packages/argus/src/watchers/requestWatcher.ts) (`returnErrorResponse: true`, checks `data.ok`, never evicts) vs [`packages/argus-client/src/client/watcherRequest.ts:36-53`](packages/argus-client/src/client/watcherRequest.ts) (throws `HttpResponseError`, **evicts the watcher from the shared on-disk registry** via `removeWatcherAndPersist`) · duplicated helpers: `buildWatcherUrl` (`requestWatcher.ts:42-48` ≡ `watcherRequest.ts:56-62`), `formatWatcherTransportError` (identical), registry prune/remove wrappers (`argus/src/registry.ts:14-24` ≡ `argus-client/src/registry/readAndPruneRegistry.ts:10-21`)

The same watcher outage produces different _persistent_ state depending on which stack observed it — the client deletes registry entries the CLI also reads. Plugins (via `requestWatcherJson`) and SDK users see structurally different error surfaces for identical wire responses. The CLI consumes `@vforsh/argus-client` in exactly one file (`evalPolling.ts`, which _was_ properly unified); everything else is duplicated.

**Fix:** Define the eviction policy once (a core `classifyWatcherFailure` → transport vs API-rejection, plus a shared evict helper) and have both stacks call it; long-term collapse both onto one core transport module, with the CLI's result-union and the client's throwing facade as thin adapters. Move `buildWatcherUrl`, `formatWatcherTransportError`, and the registry wrappers into argus-core.

### C4 — `browserCookies.ts` reimplements a second CDP transport next to `connection.ts` · `MAJOR`

**Files:** [`packages/argus-watcher/src/cdp/browserCookies.ts:26-202`](packages/argus-watcher/src/cdp/browserCookies.ts) (duck-typed `WebSocketLike`/`WebSocketCtor`, `sendBrowserCommand` with hand-rolled pending/timeout/cleanup, hardcoded request-id constants, `toMessageText` duplicating `connection.ts`'s `parseMessage`) vs `cdp/connection.ts:78-168`

~90 LOC of bespoke one-shot CDP-over-WebSocket. Hardcoded per-call request ids (`TARGET_INFO_REQUEST_ID = 1` …) exist only because there is no id allocator. Two transports in one directory means every transport fix (timeouts, binary frames, error text) must be made twice.

**Fix:** Extract `openCdpConnection(wsUrl)` from `createCdpSessionHandle` (the `attach` closure already is exactly that); browser-target commands become open → `sendAndWait` ×2 → close. Deletes ~120 LOC, leaving the file as pure cookie normalization/fallback logic.

### C5 — Parallel command implementations: `page reload` vs `chrome reload`, `eval` vs `eval-until` · `MAJOR`

**Files:** [`packages/argus/src/commands/page.ts:61-265`](packages/argus/src/commands/page.ts) vs `commands/chrome/targets.ts:187-232` and `chrome/shared.ts:52-63` · [`packages/argus/src/commands/eval.ts:10-106`](packages/argus/src/commands/eval.ts) vs [`packages/argus/src/commands/evalUntil.ts:17-101`](packages/argus/src/commands/evalUntil.ts)

`runPageReload` hand-writes watcher resolution + candidate printing (duplicating `writeResolveError`/`resolveWatcherOrExit`), hand-fetches `/json/list` twice with the error handling `loadChromeTargets` already wraps, and its no-params path duplicates `runChromeReload` — the file is two commands glued by `hasParamFlag`/`hasParamsFlag` booleans threaded through a `ReloadContext`. Separately, `eval`/`eval-until` share the entire expression/args/iframe/out surface and the same six-rung parse-warn-exit ladder; only `--until` semantics differ. Any new shared flag must land in four places.

**Fix:** Reuse `resolveWatcherOrExit` + `loadChromeTargets` and collapse page reload's two branches into "resolve a target (by targetId | by attached watcher) → `reloadTarget`". Extract `EvalCommonOptions` + one `parseEvalCommonFlags`. ~170 LOC of mirror code.

### C6 — `eval`/`eval-until` registration: 22-field identity re-mapping duplicated · `MAJOR`

**Files:** [`packages/argus/src/cli/register/evalCommands.ts:74-104,157-187`](packages/argus/src/cli/register/evalCommands.ts)

Both actions manually copy ~22 option properties into a new object where **every key maps to the same name** (`json: options.json, await: options.await, …`) — a pure identity mapping written twice, ~50 LOC. Any new shared eval flag must be added in three places; miss one and the flag parses but never reaches `runEval`. The `expression != null && options.expression != null` guard is also duplicated verbatim.

**Fix:** Pass `options` through directly; let `RunEvalOptions` be the typed contract instead of a hand-copied projection. Hoist the positional-vs-`--expression` guard into one helper. ~55 LOC and a class of "flag parsed but dropped" drift.

### C7 — Config/auth logic triplicated in the register layer; config loaded and validated twice per invocation · `MAJOR`

**Files:** [`packages/argus/src/cli/register/chromeCommands.ts:50-172`](packages/argus/src/cli/register/chromeCommands.ts), `register/quickAccessCommands.ts:60-150`, `register/watcherCommands.ts:52-78` · `cli/plugins/registerPlugins.ts:228-247` (loads global + local config on **every** invocation, pre-parse) · `config/loadConfig.ts:57-61` (prints + sets `exitCode` as a side effect)

The same ~25-line action ritual (destructure `--config` → `resolveArgusConfigPath` → bail/raw/load → merge → run) is pasted three times with drift: chromeCommands wraps in `createOptionSourceProvider`, the other two pass the raw `Command`. `normalizeAuthStateProfileOptions`/`applyAuthStateOptionOverrides` and `normalizeStartAuthOptions`/`applyStartAuthOverrides` are near-identical pairs differing only in the `authState` vs `authFrom` key, and `getOptionValueSource` is defined twice verbatim. Per the repo's own layering (register = flags/help, commands = logic), the auth/profile invariants are business rules in the wrong layer, invisible to `runChromeStart`/`runStart`'s tests. Meanwhile the config file is read, parsed, and validated twice per `chrome start`/`watcher start`/`start`, and a malformed config prints its error twice, because `loadArgusConfig` mixes reporting side effects into a loader so no caller can load quietly.

**Fix:** Load once at startup into a small config context (path, dir, config, error) consumed by both `registerPlugins` and the start commands; one `resolveOptionsWithConfig(command, options, configPath, …mergeFns)` in `config/`; move auth normalization into `commands/chromeStart.ts`/`commands/start.ts` parameterized by the one differing key; keep `loadArgusConfig` pure. ~120 LOC plus the double read and duplicate error print.

### C8 — Chrome launch/cleanup ownership split across three places · `MAJOR`

**Files:** [`packages/argus/src/commands/chromeStart.ts:277-283,412-438`](packages/argus/src/commands/chromeStart.ts) · `commands/start.ts:89-104,144-151`

`launchChrome` owns the temp profile dir but not its end-of-life: both callers reach into `result.userDataDir` to re-implement "on chrome exit, rm dir, then exit", and both re-implement the auth-state hydration block ("if authState: hydrate via CDP, on failure closeGracefully + warn + exit 1, else adopt hydrated startupUrl") plus the `options.authState ? null : startupUrl` dance.

**Fix:** Move the `exit → cleanupDir` handler inside `launchChrome` (it already owns `cleanupDir`), and add an optional auth-state step (or a `launchChromeWithAuthState` wrapper) both commands call. Profile-dir lifetime gets a single owner.

---

## Theme D — Sprawl, state, and orchestration

### D1 — `popup.ts` (709 LOC): two competing owners of the DOM · `MAJOR`

**Files:** [`packages/argus-extension/src/popup/popup.ts:706-709`](packages/argus-extension/src/popup/popup.ts) (2s full re-render), `:411-421` (hand-rolled `JSON.stringify` state hashing), `:248-261` (re-attaches listeners to every button on every render), `:556-596` + `:673-693` (~100 LOC of `setBusyButtonState`/`restoreButtonFeedback`/`setButtonFeedback`/`getButtonLabel`/`setButtonLabel`/`getButtonIconMarkup`/`setButtonIconMarkup`), `:301-312` (inline style mutation)

The popup renders by wholesale `innerHTML` replacement every 2s while a parallel system mutates individual buttons ("Attaching…", "Copied!", icon swaps) and captures restore closures over those nodes. Any forced re-render — which every action triggers via `refreshTabs(true)` — replaces the nodes, so the restore closures and their `setTimeout(restore, 1500)` operate on detached DOM. This, not feature count, is why the file is the repo's largest.

**Fix:** One delegated click listener on the container dispatching on `data-action` (deletes `bindTabInteractions` and four bind loops), and fold transient UI state (busy/copied per tabId+action) into the render state so the single render pass paints it (deletes the seven button helpers and the stale-node hazard). The decomposition then falls out: `popup-client.ts` (typed messaging, pairs with A2), `health-panel.ts`, `tabs-view.ts` — each well under 500 LOC.

### D2 — Service worker smears one entity across four parallel tabId-keyed maps reconciled by a sweep · `MAJOR`

**Files:** [`packages/argus-extension/src/background/service-worker.ts:47-52`](packages/argus-extension/src/background/service-worker.ts) (`bridgeSessions`, `selectedFrameByTabId`, `pendingRememberedTargetByTabId`), `:304-338` (`clearTabState`, `pruneStaleBridgeSessions`, `destroyBridgeSession`), `:551-561` (identity wrappers), plus `DebuggerManager.attached` as the fourth map

`pruneStaleBridgeSessions` exists purely because the maps drift (its own comment says so), runs on every popup message as a reconciliation sweep, and multi-step transitions (`attachBridgeSession` → `setSelectedFrame` → `prepareRememberedTargetSelection`) are non-atomic across them. The remembered-target replay is bolted on as a global `debuggerManager.onEvent` hook filtered by a module-level event-name set consulting one of the maps — a scattered special case in the hot event path.

**Fix:** One `Map<number, TabAttachment>` where the record owns `{session, selectedFrameId, pendingRememberedTarget}` (or hang the state off `TabBridgeSession`, which is already one-per-tab). Attach/detach/prune become single-map operations, the three wrappers go, and the replay moves into a self-contained helper owning its own event filter.

### D3 — Attach failure travels as a forged `tab_detached` for a tab that never attached · `MAJOR`

**Files:** [`packages/argus-extension/src/background/cdp-proxy.ts:126-134`](packages/argus-extension/src/background/cdp-proxy.ts) (failure sends `tab_detached` with `reason: err.message`, then rethrows — rethrow added by `a89ef4c`) · `argus-watcher/src/native-messaging/session-manager.ts:106-113` (`handleTabDetached` tolerates the nonexistent session and fires `onDetach` anyway) · `argus-extension/src/types/messages.ts:178-181`

Every other host→extension request (`cdp_command`, `cookie_query`, `list_tabs`, `control_status`, `attach_tab_watcher`) carries a `requestId` and gets a typed response; `attach_tab` alone is fire-and-forget, so failure had to be improvised as a synthetic detach whose `reason` doubles as an error message, and success is inferred from a `tab_attached` broadcast. The recent fix itself was integrated cleanly (rethrow + catch in the message pump, not a bolted-on flag) — the debt is the protocol asymmetry underneath: failure now propagates through two channels, and the watcher must permanently keep a "detach for a session we never had" tolerance branch.

**Fix:** Give `attach_tab` a `requestId` and reuse the existing `tab_action_response` shape (it already carries `ok`/`error`/`tab`). Deletes the synthetic-detach special case and the tolerance branch, and makes `tab_detached.reason` mean one thing again. Small diff once B1's shared protocol module exists.

### D4 — Source capability encoded three times per request; `CdpSourceHandle` is an 8-optional-method bag · `MAJOR`

**Files:** [`packages/argus-watcher/src/sources/types.ts:88-122`](packages/argus-watcher/src/sources/types.ts) · `http/router.ts:11` (`extensionOnly && !ctx.sourceHandle` → 404) · `routes/postAttach.ts` ≡ `routes/postDetach.ts` (byte-for-byte identical except the method called) · `routes/getTargets.ts:10-12`, `getExtensionTabs.ts:11-13`, `getExtensionDiagnostics.ts:11-13` (repeated `if (!ctx.sourceHandle?.X) return "Not available"`) · downstream `?.` fallbacks in `getNetRequestBody.ts:89-99`, `netFilters.ts:47`, `startWatcherRuntime.ts:286-296`

Capability is checked three times per request — the `extensionOnly` route flag, the `sourceHandle` presence check in the router, and per-method optionality in the handler — because the interface can't say "tab source has attach/detach, control source has listTabs/diagnostics, cdp has neither". Also `connection.ts:28-30` marks `getTargetContext?`/`getReadyTargetContext?` optional, forcing every frame-aware consumer to write the same ternary + optional-chain dance (`dom/selector.ts:57`, `visualCapture.ts:37`).

**Fix:** Replace boolean-by-optionality with a discriminated handle (`kind: 'cdp' | 'extension-tab' | 'extension-control'` with per-kind required members), or at minimum add a `defineExtensionRoute` wrapper owning the guard, the "Not available" response, the targetId coercion, and the shared `handleError` — collapsing five routes to one-liners. Make `getTargetContext`/`getReadyTargetContext` required, with the CDP handle returning `{kind:'page'}`.

### D5 — `auth.ts` (520 LOC): three concerns, four overlapping cookie normalizers · `MAJOR`

**Files:** [`packages/argus-watcher/src/cdp/auth.ts`](packages/argus-watcher/src/cdp/auth.ts) — CRUD handlers `:74-207`, snapshot export `:210-236` + `:489-520`, page-state eval `:353-399`; normalizers at `:293`, `:310`, `:323`, `:335`; `previewSecret:401-407` byte-identical to `redactToken` in `redaction.ts:197-203`

One file mixes cookie CRUD, portable auth-state snapshot assembly, and a page-state evaluator. Four normalizers with overlapping `expires`/`sameSite`/default handling produce the same `AuthCookie` shape via two different paths depending on which read API was hit.

**Fix:** Split into `authCookies.ts` (CRUD + `findContextCookie`/`readStateCookies`) and `authSnapshot.ts` (state export + metadata), sharing `inspectPageState` from a small `pageState.ts` (B5 shrinks it to ~30 lines). Collapse the normalizers to one raw→`AuthStateCookie` function plus one `AuthStateCookie`→`AuthCookie(includeValue)` projection. Export `redactToken` and delete `previewSecret`. Also delete one of `mergeCapturedAuthHeaders`/`mergeCapturedHeaders` in `redaction.ts:104-131` — byte-identical bodies.

### D6 — `recording.ts` + `tracing.ts` duplicate the exclusive-artifact-session lifecycle; ffmpeg is a separable module · `MAJOR`

**Files:** `cdp/recording.ts:202-228` vs `cdp/tracing.ts:70-96` (`resolveFinalPath` with verbatim EXDEV rename/copy/unlink fallback) · `recording.ts:483-491` vs `tracing.ts:32-40` (`createDeferred`) · `recording.ts:153-165` vs `tracing.ts:154-174` (idempotent `'stopping'` re-entry) · `recording.ts:187-198` vs `tracing.ts:187-196` (`onDetached`) · ffmpeg concern: `recording.ts:299-353,440-481`

Both recorders re-implement uuid+timestamp naming, a single `active` slot, double-stop tolerance, out-file re-resolution with an identical cross-device fallback, deferred completion, and detach cleanup. Separately, ~170 LOC of `recording.ts` (spawn ffmpeg, stderr ring, encoder args, PNG header parsing, ENOENT message) has zero CDP dependency.

**Fix:** Extract `moveArtifactFile(from, to)` into `../artifacts.ts` and a shared `createDeferred`; split ffmpeg into `cdp/ffmpeg.ts`. `recording.ts` drops to ~320 LOC of screencast/frame-pacing logic — its actual cohesive core.

### D7 — The 61-literal endpoint union is hand-maintained in two files, with two competing `query` type systems · `MAJOR`

**Files:** [`packages/argus-watcher/src/http/server.ts:21-123`](packages/argus-watcher/src/http/server.ts) (`HttpRequestEventMetadata`: endpoint union + one mega-bag `query`) · [`packages/argus-watcher/src/events.ts:98-174`](packages/argus-watcher/src/events.ts) (`HttpRequestEvent`: the same 61 literals again + a `LogRequestQuery | NetRequestQuery | TabListRequestQuery` union) · bridged at `startWatcherRuntime.ts:333-341`

Every new route requires editing the same list in two files. Worse, the two query models disagree: server.ts's all-optional grab-bag is not actually assignable to events.ts's union except through the weak-type loophole of `TabListRequestQuery` (all-optional `{url?, title?}` accepts anything sharing one property). The public event type's discrimination is therefore decorative while the sync cost is real.

**Fix:** Define the endpoint type once — ideally derive it from route definitions (`(typeof watcherRoutes)[number]['endpoint']`). Collapse to one query type. ~130 lines of duplicated literals and the false discrimination.

### D8 — Three copy-pasted "sticky desired-state" controllers · `MINOR`

**Files:** [`packages/argus-watcher/src/emulation/EmulationController.ts:14-102`](packages/argus-watcher/src/emulation/EmulationController.ts) · `throttle/ThrottleController.ts:14-85` · `visibility/VisibilityController.ts:28-66` (whose doc comment says "Mirrors EmulationController / ThrottleController")

Identical machine three times: `desired`/`applied`/`lastError` closure state, set → apply-if-attached → record error, clear → same, `onAttach` re-apply with `console.warn`. Already drifting — Visibility throws from `setLock` instead of returning `error`; Emulation carries a baseline.

**Fix:** One generic `createStickyController<TState>({ apply, clear, onAttachExtras })`; the three modules become ~15-line configurations. ~150 LOC, and the pattern clearly accretes — the next one gets it free.

### D9 — `startWatcherRuntime.ts` (417 LOC) sprawls; `createWatcherRuntimeServices` builds six services twice · `MINOR`

**Files:** [`packages/argus-watcher/src/runtime/watcherServices.ts:53-133`](packages/argus-watcher/src/runtime/watcherServices.ts) · [`packages/argus-watcher/src/startWatcherRuntime.ts:61-205,342-382`](packages/argus-watcher/src/startWatcherRuntime.ts) · `runtime/watcherSetup.ts:112` (unconditional `createCdpSessionHandle()` even in extension mode)

The extension and cdp branches duplicate the full events-mapping object and all five service constructions, differing only in `pageSession` presence. `startWatcherRuntime` inlines two coherent subsystems (page-indicator orchestration :61-155, inject-on-attach :157-205) plus a hand-rolled shutdown handshake spread over four mutable flags. `sourceHandle.pageSession ?? sourceHandle.session` repeats 6× across the two files.

**Fix:** Create `sourceHandle` per mode, then build the service block once. Extract `createIndicatorBinding` and `createInjectOnAttach` next to `watcherInject.ts`. Compute `pageSession` once. Collapse the shutdown flags to a promise latch.

### D10 — `editor.ts` (496 LOC): dense closure state machine with undocumented `reset()`/`rebind()` lifecycle · `MINOR`

**Files:** [`packages/argus-watcher/src/cdp/editor.ts:71-79,168-176`](packages/argus-watcher/src/cdp/editor.ts) · callers `startWatcherRuntime.ts:216,226,261`

Enable-once + quiet-period + listener-binding + resource-registry concerns share one closure coordinated by `enabled`/`enabling`/`listenersBound`/`settleTimer`. The `reset` vs `rebind` distinction (navigation vs re-attach) is real but undocumented and only decipherable by reading the caller; `reset` deliberately keeps `enabled` true, which looks like a bug until you know CDP domains survive navigation. Most likely file to break under a future edit.

**Fix:** Keep the file (cohesive domain) but extract the enable/settle/listener lifecycle into `createEditorDomainLifecycle(session)` exposing `ensureEnabled/onNavigated/onReattached`, with a doc comment stating the invariant. The resource maps then hold no lifecycle flags.

### D11 — Two history stores are ~60% copy-pasted persistence plumbing · `MAJOR`

**Files:** [`packages/argus-extension/src/background/target-selection-history.ts:96-135,213-251`](packages/argus-extension/src/background/target-selection-history.ts) · `background/target-visibility-history.ts:108-147,232-262`

`readStorageValue`, `writeStorageValue`, `normalizeOptionalText`, `sortByUpdatedAtDesc`, `createChromeStoragePersistence` (only the key differs), and the whole `loadPromise`/`saveChain` machinery are duplicated line-for-line. Both are the same shape of store: pageKey-normalized, max-N, most-recent-first upsert with a sanitize-on-load hook. `normalizeTargetUrl`/`normalizeTargetTitle` are identity wrappers on top.

**Fix:** A generic `page-keyed-store.ts` (persistence factory + load-once + serialized save-chain + capped upsert + `sanitize` hook). Each store shrinks from ~250 to ~100 LOC; existing tests pin behavior.

### D12 — Sequential probes where the work is independent · `MAJOR`

**Files:** [`packages/argus/src/commands/list.ts:66-76`](packages/argus/src/commands/list.ts) · `commands/doctor.ts:41,66-88` · `commands/watcherPrune.ts:55-63`

`argus list`/`doctor`/`watcher prune` await `/status` per watcher with a 2s timeout, so latency is `N × timeout` — a registry with 5 dead watchers makes `list` take ~10s. The repo already establishes the right pattern in-tree (`extension/tabAttach.ts:199-204` uses `Promise.all`, `chrome/processes.ts` probes ports concurrently). Related: `argus-client`'s `list()` re-runs the locked `readAndPruneRegistry` once per watcher (N+1 registry locks) because `requestWatcher` conflates id-resolution with the HTTP call.

**Fix:** `Promise.all(watchers.map(probe))` in all three (order-stable by index). Split `requestWatcher` into `resolveWatcher(ctx, id)` + `requestFromRecord(record, options)` so `list()` reuses records it already holds.

### D13 — Error signaling through three channels; `process.exitCode` written from library depths · `MAJOR`

**Files (sheets):** [`packages/argus-plugin-google-sheets/src/typedMutationRuntime.ts:40,96`](packages/argus-plugin-google-sheets/src/typedMutationRuntime.ts) · `sheetCommandUtils.ts:94,122,127,130` · `gidTraversal.ts` · `sheetRead.ts:39` — 11 files mutate `process.exitCode`

Failures propagate three ways at once: return `null`/`string`/`Error` (three conventions across modules), thrown exceptions (planner/apply), and direct `process.exitCode` writes from deep helpers. `setTypedRange` — a library function called inside `executePlan`, which also throws on `!verified` — sets `exitCode = 1` itself, so exit policy is smeared across the stack and any caller composing these helpers inherits surprise side effects. Separately `evalInWatcher` returns `response.data.result as T`, an unmarked trust boundary every page-result type flows through (the uniform `ok: true` field is never checked).

**Fix:** Restrict `exitCode` writes to the command layer — B10's `runSheetCommand` makes that a single site; library helpers return discriminated results only. Add one comment at the `as T` cast naming it as the eval trust boundary.

### D14 — Watcher coded errors: hand-rolled at 6+ sites, sniffed with casts at 8 more · `MINOR`

**Files:** `sources/extension-frame-state.ts:69-73` ≡ `native-messaging/session-manager.ts:319-323` (two identical `createNotAttachedError`) · `sources/extension-control-source.ts:97-105`, `sources/extension-target-recovery.ts:161-167` (same `(error as Error & {code?: string}).code = …`) · readers: `httpUtils.ts:189-197`, `domSelectorRoute.ts:57-70`, `getNetRequestBody.ts:64`, `NetMockController.ts:48-54`, `NetMockInterception.ts:201-203` · CDP-side variants: `connection.ts:180-184`, `mouse.ts:327-331`, `networkBody.ts:100-106`, `dom/info.ts:41`, `keyboard.ts:246-248` (four different idioms)

The cross-layer error contract (an `Error` with a string `code`) has no owning type or constructor, so producers mutate-and-cast and consumers re-derive sniffing. The duplicated `createNotAttachedError` is the tell: the concept exists, the abstraction doesn't.

**Fix:** One `codedError(code, message)` + `getErrorCode(error)` (argus-core or a watcher `errors.ts`); delete both `createNotAttachedError` copies and unify the readers.

### D15 — LogBuffer maintains two complete waiter/query subsystems · `MINOR`

**Files:** [`packages/argus-watcher/src/buffer/LogBuffer.ts:33-48,137-169,197-242`](packages/argus-watcher/src/buffer/LogBuffer.ts) · sole id-based consumers: `http/routes/logEpochQuery.ts:48,63` (both hardcode `after = 0`)

`Waiter`/`waitForAfter`/`flushWaiters` (id-based) and `EpochWaiter`/`waitForAfterEpoch`/`flushEpochWaiters` are parallel long-polling implementations with duplicated flush loops. The id-based path survives only as the `kind: 'all'` position query, expressible as "epoch at the start of the retained buffer". Also `getCursor()`/`beginLogEpoch()`/`getEpoch()` are three names for the identical value.

**Fix:** Route everything through the epoch waiter set; delete `Waiter`, `waitForAfter`, `flushWaiters`, `listAfter`, and the `logEpochQuery` shims (~70 LOC). Pick one epoch-getter name.

### D16 — Module-level mutable state without lifecycle: sourcemap caches, bridge request ids · `MINOR`

**Files:** [`packages/argus-watcher/src/sourcemaps/resolveLocation.ts:16-17`](packages/argus-watcher/src/sourcemaps/resolveLocation.ts) (`traceMapCache`/`pendingTraceMaps` module-global, unbounded, never invalidated) · `native-messaging/session-manager.ts:37` (`let nextRequestId = 1` at module scope while `pendingRequests` is per-instance; `ControlSessionManager` keeps its counter per-instance)

A failed or stale `.map` fetch is cached as the answer for the process lifetime, so a dev-server rebuild mid-session keeps resolving against the old map (or keeps returning null after one transient failure) — despite `handlePageNavigation` existing as the natural reset point. The two session managers also duplicate the pending-request machinery (`session-manager.ts:153-167,325-342` vs `control-session-manager.ts:102-132`).

**Fix:** Make the trace-map cache an instance owned by the watcher runtime (reset on navigation, or LRU-bounded with negative-entry TTL); move `nextRequestId` into the class; extract one `createPendingRequestTable(timeoutMessage)`.

### D17 — Mechanical sweeps · `MINOR`

| What                                                                                                                                                    | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Count                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Inline `error instanceof Error ? error.message : String(error)` where `cli/parse.ts:2` `formatError` is canonical                                       | 26 files in `argus/src/commands`, plus `registerPlugins.ts:148,160,169,291,310`, `config/loadConfig.ts:39,46`                                                                                                                                                                                                                                                                                                                                                                                                                             | 49                       |
| `delay`/`sleep` one-liners                                                                                                                              | `chromeStart.ts:64`, `watcherStop.ts:102`, `trace.ts:155`, `extension/install.ts:183`, `extension/tabAttach.ts:144`, `extension/targetSelection.ts:287`, `evalShared.ts:328`, `cdp/watcher.ts:183`, `cdp/recording.ts:493`, `cdp/mouse.ts:325`, `routes/getNetTail.ts:61`, `extension-target-recovery.ts:169`, `NetMockController.ts:270`                                                                                                                                                                                                 | 13                       |
| `{ flags: '--json', description: 'Output JSON for automation' }` literal (two files already invented a local `jsonOption` const; twenty didn't)         | every register file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ~60                      |
| Identical `collect` accumulators under five names                                                                                                       | `cli/validation.ts:1-3` (three byte-identical), `evalCommands.ts:6`, `program.ts:27`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 5                        |
| Input-source resolution (inline / `--file` / stdin) state machine                                                                                       | `evalShared.ts:97-182` (canonical), `domAddScript.ts:86-149`, `domAdd.ts:149-205`, `domFill.ts:85-131`, `codeEdit.ts:92-104`, `auth.ts:160-174`                                                                                                                                                                                                                                                                                                                                                                                           | 5 + 3 `readStdin` copies |
| Paginated watcher-fetch loops                                                                                                                           | `code.ts:305-334`, `codeEdit.ts:180-207` (byte-for-byte re-derivation), `netExport.ts:127-152`, `netSummary.ts:52-79`                                                                                                                                                                                                                                                                                                                                                                                                                     | 4                        |
| `nextAfter` cursor computation                                                                                                                          | `getNet.ts:22`, `getNetRequests.ts:22`, `getNetTail.ts:26`, `getNetWebSockets.ts:22`, `getNetSse.ts:22`                                                                                                                                                                                                                                                                                                                                                                                                                                   | 5                        |
| Hand-rolled `{ok:false, error:{…}}` literals despite httpUtils' 8 narrow helpers (the general `respondApiError(res, status, code, message)` is missing) | 13 watcher route files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ~34                      |
| `pickNumber`/`normalizeString`/`sanitizeUrl`                                                                                                            | `cdp/networkCapture.ts:571-583` ≡ `cdp/networkRealtimeCapture.ts:191-213`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2                        |
| Console bypass of the `Output` contract                                                                                                                 | `configInit.ts`, `pluginConfig.ts:53-109`, `resolveTestId.ts:8`, `iframeHelper.ts:24`, `skill.ts`, 6 `extension/*` files                                                                                                                                                                                                                                                                                                                                                                                                                  | 12 files                 |
| Paired shadow helpers of existing canonical ones                                                                                                        | `parseScreenshotClip` ≡ `parseRecordClipValue`; `record.ts:274` ≡ `trace.ts:157` `formatDurationMs`; `renderTargetTree` ≅ `renderExtensionTargetTree`; `startShared.normalizeHttpUrl` ≡ `chrome/shared.normalizeUrl`; `chrome/shared.resolveWatcherOrExit` vs `watchers/requestWatcher.resolveWatcherOrExit`; `escapeHtml` ×2 in the extension popup                                                                                                                                                                                      | ~200 LOC                 |
| Identity aliases / pass-throughs                                                                                                                        | `defineWatcherCommand.ts:54` (`requestWatcherCommandAction = requestWatcherAction`), `evalShared.ts:426-429` (`printSuccess`/`printError`), `cdp/mouse.ts:23-30` (`resolveDomSelectorMatches`, imported _from mouse_ by keyboard.ts), `cdp/editor.ts:432` (`matchesLine`), `cdp/auth.ts:409` (`compareCookies`), `registry.ts:63-65` (`updateWatcherHeartbeat` ≡ `announceWatcher`), `argus-client/src/http/fetchJson.ts` (1-line re-export), three hand-built `runtimeClient` adapters in `watcherEvents.ts:30,65` and `eval.ts:195-197` | —                        |

---

## Latent bug found in passing

> **`GET /net/ws?requestId=…` is a guaranteed 404.**
>
> [`packages/argus-watcher/src/http/httpUtils.ts:73-92`](packages/argus-watcher/src/http/httpUtils.ts) — `clampNumber` declares `fallback?: number` but returns `number`, so an absent param with no fallback silently yields `0`. In [`packages/argus-watcher/src/http/routes/getNetWebSocketConnection.ts:15-23`](packages/argus-watcher/src/http/routes/getNetWebSocketConnection.ts), `id = clampNumber(get('id'), undefined, 1)` is therefore `0` when the param is absent, `id == null` is never true, and a `?requestId=…` request always resolves `getWebSocketById(0)`.
>
> Two shadow helpers already exist to dodge the same dishonest signature: `netFilters.ts:248-249` `optionalClampNumber` and `netRequestLookup.ts`'s own `parsePositiveInt`. `sinceTs` in `getLogs.ts:33` / `netFilters.ts:46` becomes `0` too and only works because `0` is falsy in `matchesFilters`.
>
> **Fix:** Split into `clampNumber(value, fallback: number, min?, max?): number` and `optionalNumber(value, min?): number | undefined`; delete both shadow helpers; use the optional variant in `getNetWebSocketConnection`.

---

## Dead weight — pure deletions

| Where                                                                  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/argus-core/package.json`](packages/argus-core/package.json) | Phantom `commander` peer + dev dependency (leftover from `6f7f28b`, before the plugin API moved out) — violates the repo's own "keep argus-core dependency-free" mandate; zero imports in `src/`. Every consumer inherits a peer warning for a CLI framework the protocol layer never touches.                                                                                                                                                                                                                                                                                                                                                                             |
| `argus-core/src/protocol/http/status.ts:32`                            | `watcherVersion` — documented contract, produced by nothing (`getStatus.ts` never sets it), consumed by nothing. Implement or delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `argus-core/src/protocol/http/storage.ts:49-89`                        | 14 `StorageLocal*`/`StorageSession*` back-compat aliases with zero usages in the repo. Drop on the next minor with a changelog note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `argus-core/src/protocol/http/eval.ts:49-106`                          | `ArgusScenario*` in-page host-bridge types (functions returning Promises, not serializable payloads) sitting in the HTTP-payload directory. Move to `protocol/scenario.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `argus-watcher/src/native-messaging/session-manager.ts:254-314`        | `attachTab`, `enableDomain`, `getSession`, `listSessions`, `isAttached`, `getFirstSession` — zero callers; plus `AttachTabMessage`/`EnableDomainMessage` (`types.ts:178-181,224-228`) that exist only to serve them, and the never-read `enabledDomains` field (`:174,223`).                                                                                                                                                                                                                                                                                                                                                                                               |
| `argus-watcher/src/buffer/NetBuffer.ts:49-66`                          | `list`, `getById`, `getByRequestId` — zero callers (routes use `getRecordById`/`getRecordByRequestId`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `argus-watcher/src/http/routes/netFilters.ts:194-205,152`              | `normalizeFrame`'s `'selected'`/`'page'` branch returns the same value as the fallthrough (dead conditional); `defaultScope(_context)` ignores its argument.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `argus-watcher/src/artifacts.ts:19-36`                                 | `resolveArtifactPath` returns `{absolutePath, displayPath}` where the two are identical on every path — vestigial pair-shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `argus-watcher/src/cdp/tracing.ts:50`, `recording.ts`                  | `onEvent` bound at creation and never disposed — harmless today (recorder lifetime == session lifetime) but asymmetric with every other module; add a `dispose()` or a comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `argus-plugin-google-sheets`                                           | Dead in-page `withGid` traversal (`pageScripts.ts:18-22,81-97,194-216`, ~40 LOC + the `withGid`/`maxTabs`/`force`/`deadlineMs` input surface on two builders) — obsoleted by node-side `gidTraversal.ts`. `boundedTraversal.ts` and `leaseModel.ts` are test-mirror modules whose logic ships elsewhere. `candidatesToKeyedRows`, `buildClipboardExpression`, `assertSheetLease` — no callers. `typedValuesToTsv` is a **stale twin** of `typedClipboard.ts` missing `exactNumberFormula` handling (would reintroduce a fixed locale-paste bug). `parseDurationMs` lives in `mutationCommands.ts` but is imported by three unrelated files — relocate it to a shared util. |
| `argus-extension`                                                      | `cdp-proxy.ts:226-229` `getTabsForPopup` and `bridge-client.ts:41-43` `onConnect` — zero callers; `target-visibility-history.ts:94-97` `isHidden` used only by its own test; `watcher-status.ts:48-49` sets `bridgeConnected` and `nativeHostConnected` to the identical value; `targetReady` shipped alongside its fully-derived `targetState`; `recentEvents` computed and shipped every 2s to a popup that ignores it. `tab-bridge-session.ts:87-104,156-173,206-221` — `waitUntilReady`/`waitForWatcherInfo` are the same waiter mechanism written twice (~60 LOC where a 12-line `createLatch()` used twice would do).                                                |
| `packages/argus/src/commands/evalShared.ts`                            | 475 LOC / five concerns, kept at the 500-LOC line by re-export shims (`:12-16`, "for existing imports") and two identity aliases (`:426-429`). Move iframe wrapping to `evalIframe.ts` and emitters to `evalEmit.ts`; migrate importers off the shims.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/argus/src/commands/authCookieSupport.ts:161-177`             | `normalizeExportFormat` does a `Set.has` check followed by a switch over the same three literals — one validation is dead weight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `e2e/`                                                                 | Deep imports into package `src/` internals (`argus/src/commands/evalShared.js` ×3, `argus-watcher/src/cdp/connection.js` ×3, `argus/src/output/io.js`, `argus-watcher/src/cdp/eval.js`, `argus/src/eval/evalClient.js`, `argus/src/config/mergeConfig.js`, `argus-core/src/registry/types.js`) — so export hygiene and the "public API must be documented" rule are unenforced, and e2e passing says nothing about the published surface.                                                                                                                                                                                                                                  |
| `playground/iframe.html:56-78`                                         | A hand-pasted frozen copy of the `argus iframe-helper` generator's output (doc comment included). If the postMessage protocol in `iframeHelper.ts`/`evalShared.ts:449` changes, the designated smoke-test harness keeps testing the old protocol. Serve it from `generateIframeHelperScript` at request time.                                                                                                                                                                                                                                                                                                                                                              |
| Two esbuild majors in one artifact                                     | `argus-extension` pins `esbuild ^0.24.2` while `argus` ships `0.25.12`, and the CLI's `copy-argus-extension.mjs` builds the extension during the CLI's own bundle step. Align or hoist to root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## Suggested sequencing

Ordered so each step removes the template the next batch of code would have been copied from.

1. **Day-one deletions and fixes.** Drop the phantom commander dep; delete the dead methods, aliases, and branches from the table above; move `parseDurationMs` to argus-core; fix the WebSocket-lookup bug. Zero risk, shrinks everything after.
2. **Contract seams.** Native-messaging types → argus-core (kills B1); type `/targets` + attach/detach requests (A3); derive argus-client types via `Omit` (A1); unify the popup protocol (A2); start checking `protocolVersion` (A6); invert the plugin-api dependency and delete the cast (A5).
3. **The two big judo moves in the watcher.** Typed `CdpCommandMap`/`CdpEventMap` (B4), then schema-only POST bodies (B7). Together they delete ~900 LOC of casts and hand validation and retire the `readJsonBody` gotcha from AGENTS.md. Follow with `evaluateInPage`/`callFunctionOnNode`/`mutateMatchedElements` (B5, B6).
4. **CLI seams.** `defineCommand` option normalization (B8), then delete `parseNetArgv` (B2); the extension `emitFailure` module (B3); the `build → formatHuman` joint (B9); eval consolidation (C5, C6); config-load-once (C7).
5. **Extension redesign.** `frame_snapshot` replacing forged CDP events (C2); single `TabAttachment` map (D2); popup DOM ownership + decomposition (D1); give `attach_tab` a requestId (D3); generic page-keyed store (D11).
6. **google-sheets.** Shared `runSheetCommand` runner (B10) + `buildPageExpression` (B11), then the page-script and dead-code deletions on the smaller surface.

After each step: `npm run typecheck` and `npm run lint` (use `npm run lint:fix` for auto-fixable issues), and fix anything they report.

---

## Per-package health

| Package                      | LOC  | Verdict                                                                                                                                                                                                                                         |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argus` (CLI)                | 21k  | Strong declarative core (`defineCommand`/`domCommandBuilder`/`defineWatcherCommand`); most register files are correctly inert option tables. Rot at two seams: the Commander boundary and the extension command family. ~700–900 LOC deletable. |
| `argus-watcher`              | 18k  | Good route spine and genuinely deliberate listener/lifecycle hygiene. Missing the typed second layer above `CdpSessionHandle`, which is where nearly all redundancy lives. Findings 1–4 in each slice ≈ 800 LOC.                                |
| `argus-core`                 | 3.3k | Contracts are good and consumers genuinely import them; nothing makes them _stay_ good. GET side untyped, envelope inlined 71×, two validation frameworks, one phantom dependency.                                                              |
| `argus-client`               | 1.5k | `pollEval` and `hydrateAuthState` are textbook transport-agnostic design. The 434-LOC hand-mirrored type universe is the whole problem.                                                                                                         |
| `argus-extension`            | 4k   | Clean micro-level code, real JSDoc on non-obvious invariants, and the two recent fixes were integrated cleanly. One systemic disease: contracts by copying — roughly a quarter of the lines are second or third copies.                         |
| `argus-plugin-google-sheets` | 5.6k | Safety invariants (leases, preconditions, bounded traversals, mandatory verification) are explicit and mostly single-sourced. ~450 LOC of pipeline and page-script duplication is the debt this audit targets.                                  |
| `argus-plugin-api`           | 0.2k | Commendably minimal and versioned. The unchecked `defineWatcherCommand` cast, the mirrored types, and `exitCode` leaking CLI semantics are the only leaks.                                                                                      |

**Architectural integrity:** the monorepo still matches its stated architecture where AGENTS.md actually drew the map — HTTP request/response types live in `argus-core/protocol/http` and are imported at both ends for the mature domains, the watcher emits the envelope uniformly via `satisfies ErrorResponse`, route conventions hold, and the eval polling loop is a model example of deliberate seam engineering. The drift is concentrated exactly where the map has blank spots: the extension wire contract, the extension-mode HTTP routes that skipped the Golden Path, a CLI/SDK split that the dual golden path quietly legitimized into four copies of transport plumbing, and a protocol-version mechanism no consumer reads. Nothing here is rot at the core — it is accretion at the newest three seams (extension, plugins, SDK), and all of it is fixable by moving code _down_ into argus-core / plugin-api rather than by rewrites.
