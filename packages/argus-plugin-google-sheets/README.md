# @vforsh/argus-plugin-google-sheets

Argus CLI plugin for working with the Google Sheets document already open in an attached browser tab.

Reads use Google Sheets CSV export from inside the authenticated tab. Writes select a range in the live UI, copy TSV to the browser clipboard, then paste with the platform shortcut.

## Enable

Build the package, then add it to Argus config:

```json
{
	"plugins": ["@vforsh/argus-plugin-google-sheets"]
}
```

For local development, point at the built file:

```bash
ARGUS_PLUGINS=./packages/argus-plugin-google-sheets/dist/index.js argus sheets read extension-2 --range A1:C5
```

## Commands

```bash
argus sheets list extension-2
argus sheets list extension-2 --with-gid
argus sheets info extension-2
argus sheets switch extension-2 "Burn rate"
argus sheets open extension-2 2
argus sheets switch extension-2 2
argus sheets add extension-2
argus sheets rename extension-2 "Sheet 3" "Archive"
argus sheets move extension-2 "Archive" 1
argus sheets remove extension-2 "Sheet 3" --force
argus sheets rows add extension-2 5 --count 2 --before
argus sheets rows remove extension-2 5 --count 2 --force
argus sheets columns add extension-2 3 --after
argus sheets columns remove extension-2 3 --force
argus sheets read extension-2 --range A1:C5
argus sheets export extension-2 --range A1:C5 --format tsv
argus sheets find extension-2 "Play" --column ru --ignore-case
argus sheets select extension-2 B12
argus sheets write extension-2 B12 --value "Новое значение"
cat rows.tsv | argus sheets write extension-2 B12 --stdin
```

`sheets` also has the alias `gs`.

## Notes

- The watcher must point at a Google Sheets tab that the current browser session can access.
- `list` reports visible sheet tabs. `--with-gid` briefly switches through those tabs, then restores the originally active sheet.
- `switch`/`open`, `rename`, `move`, and `remove` accept a visible sheet name, 1-based visible index, or gid.
- `add`/`create` uses the live Google Sheets UI and switches to the new sheet.
- `move` uses a 1-based visible sheet index as its destination.
- `remove`/`delete` requires `--force`.
- `rows add/remove` and `columns add/remove` operate on the active sheet. Targets are 1-based indexes; add commands require exactly one of `--before` or `--after`; remove commands require `--force`.
- `read`, `export`, and `find` can read ranges that are not visible because they use the CSV export endpoint.
- `write` changes the live sheet through the browser UI; keep the tab focused on the intended document and range.
