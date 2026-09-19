# DOM, Snapshot, Locate

Read the page structure, find elements, get stable refs, and mutate DOM. Runs against the selected iframe when one is selected.

## Element Targeting (shared by DOM + interaction commands)

| Flag                | Meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `--selector <css>`  | CSS selector                                                                                     |
| `--testid <id>`     | Shorthand for `--selector "[data-testid='<id>']"`                                                |
| `--ref eN`          | Stable ref from `snapshot` / `locate` output (`info`, `focus`, `click`, `drag`, `hover`, `fill`) |
| `--text <str>`      | Keep only matches whose trimmed `textContent` matches; `/regex/flags` allowed                    |
| `--all`             | Allow >1 match (default: `multiple_matches` error)                                               |
| `--wait <duration>` | Poll for the selector before acting (`set-file`, `click`, `fill`, `drag`)                        |

## Discovery

```bash
argus snapshot app                          # accessibility tree with refs (alias: snap, ax)
argus snapshot app --interactive            # -i: buttons, links, inputs only
argus snapshot app --selector "form" --depth 3
argus locate role app button --name "Submit"                     # role + accessible name
argus locate text app "Continue" --action click                  # find and act
argus locate label app "Email" --action fill --value "me@x.io"   # form control by label
argus locate role app link --all --json
```

`locate` errors on >1 match unless `--all`; `--exact` requires exact normalized text. `--action` runs `click`, `fill`, `focus`, or `hover` on the single match. Refs (`e5`) are watcher-local handles on backend node ids: stable for the lifetime of the document, gone after navigation/reload (`invalid_ref`). Re-run `snapshot`/`locate` to mint fresh ones.

## Inspect

```bash
argus dom tree app --selector "body" --depth 2         # default depth 2, --max-nodes 5000
argus dom tree app --testid "main-content" --json
argus dom tree app --selector "li" --all --text "/Total/i"
argus dom info app --selector "#root"                  # box, attrs, computed basics, outerHTML (--outer-html-max)
argus dom info app --ref e3
```

## Mutate

```bash
argus dom focus app --selector "#input"
argus dom add app --selector "#container" --html "<div>Hello</div>"          # default position beforeend
argus dom add app --selector "body" --position append --html-file ./snippet.html
cat snippet.html | argus dom add app --selector "#root" --html -
argus dom add app --selector ".item" --all --position afterend --html "<hr>"
argus dom add app --selector ".item" --nth 2 --html "<hr>"                   # --first = --nth 0; --expect N guards count
argus dom add app --selector "#banner" --text --html "Preview mode"          # insertAdjacentText
argus dom add-script app "console.log('hi')"                                 # <script> in head (--target body)
argus dom add-script app --src "https://cdn.example.com/lib.js" --type module --id my-lib
argus dom add-script app --file ./debug.js
argus dom remove app --selector ".debug-overlay"
argus dom modify attr app --selector "#btn" disabled data-loading=true --remove data-temp
argus dom modify class app --selector "#btn" +active -hidden ~loading        # or --add/--remove/--toggle
argus dom modify style app --selector "#btn" color=red font-size=14px --remove opacity
argus dom modify text app --selector "#msg" "Hello"                          # text filter here is --text-filter
argus dom modify html app --selector "#container" "<p>New</p>"
argus dom set-file app --selector "input[type=file]" --file ./a.zip --file ./b.png --wait 5s   # alias: dom upload
```

Positions for `dom add`: `beforebegin|afterbegin|beforeend|afterend` (aliases `before|prepend|append|after`).

## Scrolling

```bash
argus dom scroll app --by 0,300                          # real wheel events (alias: dom wheel)
argus dom scroll app --selector ".panel" --by 0,200
argus dom scroll app --pos 400,300 --by 0,-120
argus scroll-to app --selector "#footer"                 # scrollIntoView; same as `dom scroll-to`
argus scroll-to app --to 0,1000 | --by 0,500             # viewport or element (--selector) position
```

`dom scroll` dispatches CDP mouse-wheel input (triggers `wheel`/`scroll` listeners, number-input spin); `scroll-to` sets scroll position directly.

## Live CSS / JS

For runtime stylesheets and scripts (list, grep, deminify, live CSS edits) see [CODE.md](./CODE.md).
