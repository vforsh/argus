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
- `read`, `export`, and `find` can read ranges that are not visible because they use the CSV export endpoint.
- `write` changes the live sheet through the browser UI; keep the tab focused on the intended document and range.
