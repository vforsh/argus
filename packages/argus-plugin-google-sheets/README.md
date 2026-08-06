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

Cell types are distinct: JSON string is literal text, number is numeric, boolean is boolean, `null` is native clear, and `{ "formula": "=..." }` is an explicit formula. Dense matrices must be rectangular; sparse maps preserve omitted cells. Verification reads raw typed values from Google Sheets' own UI copy payload plus exact formula-bar sources, not locale-formatted exports. Decimal numbers are entered as exact temporary arithmetic formulas and converted to values before typed readback; requested formulas remain formulas.

Successful execution writes a journal and reverse-ordered rollback manifest beside the input file by default. Journals explicitly report partial completion; structural insertions receive a verified `deleteRows` inverse where feasible. No output calls apply transactional or atomic.

## Structural and compatibility commands

```bash
argus sheets rows add extension-2 5 --count 2 --after --sheet "Август" --expect-cell 'A5=anchor'
argus sheets rows remove extension-2 5 --count 2 --sheet "Август" --expect-cell 'A5=obsolete' --force
argus sheets columns add extension-2 3 --count 2 --before --sheet "Август"
argus sheets clear extension-2 J57:J58 --sheet "Август"
```

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
