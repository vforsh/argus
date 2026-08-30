# Google Sheets Typed Mutations — Delta Plan

Status: typed engine shipped; this document plans the remaining delta
Package: `@vforsh/argus-plugin-google-sheets`

## Shipped Baseline (do not rebuild)

The typed mutation engine is implemented and tested. Any work below extends it; nothing below reintroduces a parallel engine, schema, or verifier.

- **Typed value model** — `CellValue = string | number | boolean | null | { formula }` with empty-string rejection, finite-number checks, `-0` normalization, and mandatory `=` prefix for formulas (`src/typedValues.ts`).
- **Versioned manifest v1** — `setRange`, `setCells`, `clear`, `updateByKey`, `insertRowsAfter`, `deleteRows`, strict unknown-key rejection, JSON-path errors (`src/manifest.ts`).
- **Planner with preflight** — sheet resolution, semantic row locators, sha256 state snapshot, per-step `before`/`after` rectangles (`src/applyPlanner.ts`).
- **`sheets apply`** — `--dry-run`/`--yes` gate, page-scoped leases, immediate per-step precondition rechecks, execution journal, rollback-manifest generation (`src/applyCommands.ts`).
- **Dual-MIME typed clipboard** — TSV fallback plus HTML with `data-sheets-value`/`data-sheets-formula`; all-null payloads rejected in favor of native clear; exact-arithmetic formulas for non-integer numbers to avoid locale paste parsing (`src/typedClipboard.ts`).
- **Raw typed verification** — reads Google's compact-table copy MIME for raw type/value plus formula source; never verifies mutations against CSV (`src/rawCellValues.ts`).
- **Native clears** — `clearTypedRange` dispatches native keys; empty writes never touch the clipboard (`src/typedMutationRuntime.ts`).

Kept as-is, explicitly: preconditions, dry-run, journal, rollback, leases, `updateByKey`/`insertRowsAfter`/`deleteRows`, bounded gid traversal. None of these are deleted or degraded by this plan.

## Remaining Problems

1. **Legacy `write`/`batch` still registered.** `src/mutationCommands.ts` (458 LOC), `src/batchInput.ts` (102), and `src/mutationPageScripts.ts` (194) keep the string/TSV path alive next to the typed engine: string-only inputs, plain-TSV sparse geometry, CSV-presentation verification. Two mutation paths, one of them unsafe — the unsafe one must go.
2. **No lightweight typed write.** Changing one cell requires authoring a manifest file with `expect` rectangles. Agents need `sheets set` / `sheets clear` for scalar and dense-matrix cases without a manifest.
3. **Verification is O(cells).** `readTypedMatrixFromClipboard` selects and copies every cell individually. A 5×10 verify costs 50 UI round trips; one rectangle selection copies the whole compact table at once.
4. **Newlines in text are silently munged.** Both the TSV and HTML serializers rewrite `\r?\n` to a space (`typedClipboard.ts`), so stored text differs from requested text without an error. Silent data mutation violates fail-closed.
5. **No format-only copy.** Copying visual formatting between ranges is manual and coordinate-driven, which name-box re-scrolling makes unsafe.

## Out of Scope

Official Sheets API auth, private `batchexecute` endpoints, GViz reads, data validation, notes, comments, conditional-formatting rules, protected ranges, merged cells, array formulas, filters. UI mutations remain sequential and explicitly non-atomic.

GViz verification was considered and rejected: it adds an auth surface and wrapper-drift risk, and it cannot return formula source. The compact-table copy path already returns raw types and formulas; Phase B makes it fast instead of replacing it.

## Phases

### Phase A — Delete legacy `write`/`batch`, add `set`/`clear`

Delete `src/mutationCommands.ts`, `src/batchInput.ts`, and `src/mutationPageScripts.ts` (~750 LOC). Untangle the two shared helpers first:

- move `parseDurationMs` (imported by `commands.ts`) into `src/sheetCommandUtils.ts`;
- move `buildVerifyClearExpression` (imported by `typedMutationRuntime.ts`) into `src/typedMutationPageScripts.ts`.

Register two thin frontends next to `apply` — option parsing and output formatting only, executing through the existing `setTypedRange`/`clearTypedRange`:

```bash
argus sheets set extension E12 --sheet "Factory: Solitaire" --number 0.5
argus sheets set extension A1 --sheet "Factory: Solitaire" --json-values '[["id","target"],[1,4],[2,null]]'
argus sheets clear extension D66:E70 --sheet "Factory: Solitaire"
```

`sheets set` requires exactly one of `--text`, `--number`, `--boolean`, `--formula`, `--json-values`, `--file`, `--stdin`. Values go through the existing `parseCellValue`/`parseMatrix`; `--text ''` fails with `Empty text is not a clear operation; use sheets clear or null in a manifest.` `set`/`clear` run without `expect` preconditions (that is their point — quick writes); `apply` keeps mandatory preconditions unchanged. Verification stays mandatory everywhere; there is no unverified success.

Result JSON reuses the `apply` step shape so humans and automation see one contract.

Exit: exactly one mutation path exists; `sheets write`/`sheets batch` are gone from registration, help, README, and skill docs.

### Phase B — Batch verification via single rectangle copy

Extend `src/rawCellValues.ts` to select the whole target rectangle once, dispatch one copy, and parse every cell from the compact-table payload, replacing the per-cell loop.

- Characterize first: capture real compact-table payloads for multi-cell selections covering text, number, boolean, formula, and blank cells, including fully empty rows/columns; store sanitized fixtures under `test/fixtures/`.
- Parse strictly against the captured schema; on any shape drift, fail closed with a clear error — no silent fallback to formatted text.
- Formula source: confirm the multi-cell payload carries per-cell formulas. If it does not, keep per-cell reads only for formula-bearing cells and batch the rest.

Exit: verifying an R×C rectangle costs O(1) UI round trips (plus at most one per formula cell if required), with identical mismatch reporting.

### Phase C — Newline fidelity (fail closed, then support)

Step 1: stop the silent munge — `parseCellValue` rejects text containing `\r` or `\n` with an actionable error. Ship this with Phase A.

Step 2 (optional, only if a real consumer needs multi-line text): characterize what Sheets copies for a multi-line cell, mirror that encoding in `typedClipboard.ts` HTML cells, verify round-trip through the compact-table read, and lift the rejection. Do not guess the encoding.

### Phase D — Format-only copy (`copyFormat`)

The only genuinely new capability. Add one manifest operation and wire it through the existing planner/engine/journal:

```ts
{ op: 'copyFormat'; sheet: string; from: string; to: string; tile?: boolean }
```

- Geometry: shapes must match exactly unless `tile: true`; tiled source dimensions must divide target dimensions exactly. Validate in the planner, before any browser work.
- Execution (no screen coordinates): snapshot target typed values and formulas → select source via name box → native copy → select target → format-only paste shortcut, with the accessible `Edit → Paste special → Format only` menu as fallback → re-read target content and fail if any value or formula changed.
- Copies fill, font/style/size/color, borders, alignment, wrapping, rotation, and number format. Never copies values, formulas, validation, notes, comments, conditional rules, or dimensions. Rollback for `copyFormat` is recorded as unavailable in the journal (format snapshots are not introspectable); content preservation is what gets verified.
- New page scripts live in `src/formatPageScripts.ts`; keep it under ~500 LOC like every other module.

Exit: live test proves formatting transfers while a typed readback of the target is byte-identical to the pre-copy snapshot.

### Phase E — Docs and release gate

Update `README.md`, `skill/argus/SKILL.md`, and `skill/argus/reference/PLUGINS.md`: remove `write`/`batch`, document `set`/`clear`/`copyFormat`, add migration notes (`write --value X` → `set --text/--number X`; `batch` → `apply`). Rebuild packages serially; bump the package version per release hygiene.

## Tests

- **Phase A**: unit tests for `set` flag exclusivity, empty-text rejection, matrix validation reuse; e2e proving `write`/`batch` are unregistered and `set`/`clear` round-trip typed values in the playground sheet.
- **Phase B**: fixture-driven parser tests for multi-cell compact payloads (all types, empty geometry, drift → error); live smoke comparing batch read against known cell values.
- **Phase C**: `parseCellValue` newline rejection; round-trip test gated on step 2.
- **Phase D**: geometry/tiling validation units; live matrix — fill, font, borders, alignment, wrapping, number format transfer; target values, formulas, notes, and dimensions unchanged; mixed-content target preserved byte-exact.
- **Regression**: existing `apply` e2e suite must pass untouched after every phase — it is the proof that the engine was extended, not forked.

## Risks

- **Compact-table schema drift** (Phase B): pinned fixtures, strict parsing, fail closed. The single-cell parser already ships; the batch parser extends the same file.
- **Formula source absent in batch payload** (Phase B): fall back to per-cell reads for formula cells only; never accept computed-value equality.
- **Format-paste shortcut varies by platform** (Phase D): centralize modifier resolution in `sheetCommandUtils.ts`; accessible menu fallback; test macOS and Ctrl paths.
- **Hidden consumers of legacy modules** (Phase A): the two known shared helpers are relocated first; typecheck across the workspace catches the rest before deletion lands.

## Acceptance Criteria

- One planner, one engine, one verifier serve `set`, `clear`, `apply`, and `copyFormat`.
- `sheets write`, `sheets batch`, `batchInput.ts`, `mutationCommands.ts`, and `mutationPageScripts.ts` no longer exist.
- Verification cost is independent of cell count (modulo formula cells if Phase B requires it).
- Text with newlines fails loudly (or round-trips exactly, if Phase C step 2 ships).
- `copyFormat` changes no content, metadata, or dimensions, and uses no screen coordinates.
- Preconditions, dry-run, journal, rollback, leases, and structural operations behave exactly as before.
- README and skill docs match registered commands.

## Final Checklist

After each phase: `npm run build:packages` (serial), then `npm run typecheck` and `npm run lint`; fix every error (`npm run lint:fix` where appropriate). Before release: focused plugin tests plus the live playground smoke run.
