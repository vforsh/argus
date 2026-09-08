# @vforsh/argus-plugin-google-sheets

Argus CLI plugin for inspecting and safely changing a Google Sheets document already open in an attached authenticated browser tab. It uses the supported Google Sheets UI and browser-origin CSV export; it does not call private `batchexecute` APIs.

## Enable

```json
{
	"plugins": ["@vforsh/argus-plugin-google-sheets"]
}
```

Local development:

```bash
npm run build --workspace @vforsh/argus-plugin-google-sheets
argus --plugin ./packages/argus-plugin-google-sheets/dist/index.js sheets --help
```

`sheets` and `gs` are aliases.

## Safe inspection

```bash
argus sheets list extension-2
argus sheets list extension-2 --with-gid
argus sheets resolve extension-2 "Иконки Август" --json
argus sheets info extension-2 --json
argus sheets read extension-2 --sheet "Август" --range A1:C5 --json
argus sheets read extension-2 --sheet "Август" --range A1:E5 --typed --json
argus sheets schema extension-2 --sheet "Август" --header-row 1 --json
argus sheets find extension-2 "База Флеш Престиж" --sheet "Иконки" --max-row 5000 --json
argus sheets query extension-2 --sheet "Август" --header-row 1 \
  --where 'Айди акции promoId in [872,873,876,877,879]' \
  --select 'Айди акции promoId,Иконка icon' --locate --json
```

Whole-sheet CSV/GViz exports can collapse completely blank physical rows. Consequently:

- export candidates expose `exportRow`, never a fabricated physical coordinate;
- `find` always performs a second bounded scan of exact single-row ranges and returns only verified physical A1 matches;
- `query --locate` resolves selected candidates the same way; without `--locate`, every row has `location: null`;
- hidden rows are included because exact reads address physical row numbers rather than visible row order.

`read --sheet` JSON separates `targetSheet`, `targetGid`, and `targetUrl` from `browserCurrentUrl` and `browserRestoredUrl`. A restored browser URL is never labeled as the target URL.

### `read --typed`

`--typed` answers from the raw Google Sheets copy payload instead of the CSV export, so it reports what a cell actually holds rather than how it is rendered: `1,5` comes back as the number `1.5`, `"0123"` stays text, `#DIV/0!` becomes an `error` label rather than a string, and a formula cell reports both its computed value and its A1 source. JSON adds `cells` (per-cell `value`, `formatted`, `hasFormula`, `formula`, `error`) and `values` (the manifest-ready form, with formula cells as `{ "formula": "=…" }`); the human format prints the `formatted` grid.

It requires `--range`, because only a rectangle preserves geometry, and it refuses `--format csv|tsv` rather than silently answering from a different source. Cost is three watcher round trips for the whole rectangle plus two more per formula cell, since a formula's A1 source is only available from the formula bar, one selection at a time.

`list --with-gid` refuses more than 100 tabs unless `--force` is explicit. Traversal has an internal deadline shorter than the watcher request timeout, prints progress to stderr, and restores the original sheet in `finally`. Prefer `resolve <known-name>` for large documents; it activates only the named tab and restores immediately.

## Header query assertions

Supported `--where` operators:

```text
Header equals value
Header = value
Header in ["a","b",872]
Header contains substring
Header substring substring
Header regex /^promo-/i
```

`--expect-count <n>` and `--expect-unique` apply to the full result before `--limit`. Assertion failure exits 1; invalid flags/expressions exit 2.

## Keyed diff

```bash
argus sheets diff extension-2 --sheet "Август" \
  --against balanceBackup/promo.promo-august.csv \
  --key 'Айди акции promoId' --columns 'Иконка icon' --json

argus sheets diff extension-2 --sheet "Август" --against promo.csv \
  --key 'Айди акции promoId' --columns 'Иконка icon' --emit-plan changes.json
```

Diff reports stable `additions`, `removals`, `changes`, duplicate/missing-key diagnostics, and exact coordinates for existing changed/removed rows unless `--no-locate` is used. `--emit-plan` writes `updateByKey` operations only when every difference is an update; it refuses additions/removals instead of silently producing a partial plan.

## Declarative apply

Apply is sequential UI automation, not a transaction. The entire manifest is resolved and preflighted before the first mutation; every step is rechecked immediately before execution and typed readback is mandatory afterward.

```bash
argus sheets apply extension-2 --file changes.json --dry-run
argus sheets apply extension-2 --file changes.json --yes --json
```

Exactly one of `--dry-run` or `--yes` is required. `--force` is intentionally unsupported and cannot bypass validation.

```json
{
	"version": 1,
	"operations": [
		{
			"op": "insertRowsAfter",
			"sheet": "Иконки",
			"headerRow": 1,
			"match": { "column": "Название", "equals": "База Флеш Престиж" },
			"expectMatches": 1,
			"rows": [["Флеш 1 Престиж", null, null, null, "promo_icons/flash_frame_purpure"]]
		},
		{
			"op": "updateByKey",
			"sheet": "Август",
			"headerRow": 1,
			"keyColumn": "Айди акции promoId",
			"valueColumn": "Иконка icon",
			"changes": {
				"872": { "expect": "База Флеш Престиж", "set": "Флеш 2 Престиж" }
			}
		},
		{
			"op": "setRange",
			"sheet": "Август",
			"range": "D5",
			"expect": [[872, true, null]],
			"values": [[873, false, { "formula": "=A1/2" }]]
		},
		{
			"op": "setCells",
			"sheet": "Август",
			"cells": {
				"A10": { "expect": "old", "set": "new" },
				"D10": { "expect": 1, "set": 2 },
				"E10": { "expect": true, "set": null }
			}
		},
		{
			"op": "clear",
			"sheet": "Август",
			"range": "J57:J58",
			"expect": [["old"], [true]]
		}
	]
}
```

Cell types are distinct: JSON string is literal text, number is numeric, boolean is boolean, `null` is native clear, and `{ "formula": "=..." }` is an explicit formula. Dense matrices must be rectangular; sparse maps preserve omitted cells.

Typed values reach the grid through Google Sheets' own clipboard envelope (`<google-sheets-html-origin>`), which is the only form in which Sheets honours an explicit cell type. Outside it Sheets re-parses the visible text, so `"123"`, `"0123"` and `"TRUE"` silently became a number, a number and a boolean. Inside the envelope a formula is the one value carried as plain cell text rather than an attribute, because `data-sheets-formula` is interpreted as R1C1 there and an A1 source in it stores as `#ERROR!`.

Verification reads raw typed values from one Google Sheets UI copy of the whole rectangle — three round trips regardless of size — and compares types, not rendered text. A formula, an error and a computed value are three different states: a leftover formula never passes as its own result, and `=""` never passes as a clear. Formula-bar sources are read only for cells whose expectation is itself a formula, at two round trips each. A formula expectation matches on its source alone, so a formula that stores but does not evaluate (see the locale note below) verifies as written.

Formulas are entered in the document's own locale. A Russian-locale document expects `;` as the argument separator, so `=DATE(2024,1,2)` written from a manifest becomes `#ERROR!` while `=DATE(2024;1;2)` works; the same applies to the Insert/Edit menu labels the `rows`/`columns` commands drive, which are matched in English.

Successful execution writes a journal and reverse-ordered rollback manifest beside the input file by default. Journals explicitly report partial completion; structural insertions receive a verified `deleteRows` inverse where feasible. No output calls apply transactional or atomic.

## Structural and compatibility commands

```bash
argus sheets rows add extension-2 5 --count 2 --after --sheet "Август" --expect-cell 'A5=anchor'
argus sheets rows remove extension-2 5 --count 2 --sheet "Август" --expect-cell 'A5=obsolete' --force
argus sheets columns add extension-2 3 --count 2 --before --sheet "Август"
argus sheets clear extension-2 J57:J58 --sheet "Август"
```

`apply`'s `clear` operation selects the whole range and presses `Delete` once, then verifies with one raw rectangle read — two round trips for any size. The readback is raw rather than CSV because CSV renders `=""` and an error cell as empty text, so a formula the clear failed to remove would otherwise read back as a successful clear. The legacy `sheets clear` command still clears cell by cell and verifies through CSV.

Dimension `--count` selects the entire dimension block and performs one UI insertion/deletion. `--sheet` and `--expect-cell A1=value` prevent active-tab and stale-anchor mistakes; the command verifies both the anchor and the following row/column shift.

Legacy `write` and `batch` remain for compatibility but are deprecated in favor of versioned `apply`. Empty writes and disabled verification (`--no-verify` or `"verify": false`) are rejected; any verification mismatch exits 1 regardless of the legacy `--strict` flag.

## Migration notes

- Old `find` output that treated export indexes as A1 rows was incorrect. JSON consumers must use `matches[].sheetRow`/`matches[].a1`; `candidateMatches[].exportRow` is deliberately a separate export-only coordinate.
- Use `query --locate` when downstream automation needs physical coordinates. Unlocated query rows intentionally contain `location: null`.
- Move mutation automation from `write`/`batch` to versioned `apply`; old commands remain available but cannot disable mandatory verification or use empty writes as clear.

## Concurrency and exit codes

Every multi-call UI flow holds a page-scoped owner-token lease with TTL. Overlapping CLI processes fail with the current operation and remaining lease time; owner-only renew/release prevents one process from unlocking another. Reload clears the page lease, and stale TTL permits recovery.

- exit 0: successful read/dry-run or every mutation verified;
- exit 1: browser/runtime, stale precondition, incomplete locator, or verification failure;
- exit 2: invalid CLI flags/input/manifest or missing explicit confirmation.

JSON data is written only to stdout. Traversal/locator progress and warnings are written to stderr.
