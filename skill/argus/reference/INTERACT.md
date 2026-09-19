# Interaction

Real Chrome input events (mouse, keyboard, wheel) dispatched via CDP. Element targeting flags are shared with DOM commands ([DOM.md](./DOM.md#element-targeting-shared-by-dom--interaction-commands)): `--selector`, `--testid`, `--ref`, `--text`, `--all`, `--wait`.

## Click / Hover

```bash
argus click app --selector "button.submit"
argus click app --testid "submit-btn"
argus click app --ref e5
argus click app --pos 100,200                       # viewport coords
argus click app --selector "#btn" --pos 10,5        # offset from element top-left
argus click app --selector ".item" --all
argus click app --selector "#btn" --button right    # left|middle|right
argus click app --selector ".delayed" --wait 5s     # poll for selector first
argus hover app --selector ".menu-item"
```

## Drag

```bash
argus drag app --selector "#piece" --by 120,0
argus drag app --selector "canvas" --pos 320,240 --by 80,-30       # start offset inside element
argus drag app --pos 200,300 --to 500,300                          # absolute viewport start/end
argus drag app --ref e7 --by 0,-180 --duration 600ms --steps 30
```

`mousePressed → N × mouseMoved → mouseReleased`, default 250ms / 12 steps. Works for canvas/WebGL games. Exactly one of `--to` / `--by`.

## Fill

```bash
argus fill app --selector "#username" "Bob"
argus fill app --name "title" "Hello"                # --name = --selector "[name=title]"
argus fill app --ref e7 --value "Bob"
argus fill app --selector "#desc" --value-file ./description.txt
echo "hello" | argus fill app --selector "#input" --value-stdin      # or "-" as the value
argus fill app --selector "input[type=text]" --all "reset"
```

Targets `input`, `textarea`, and `contenteditable`; fires `input`/`change` like a user edit.

## Keyboard

```bash
argus keydown app --key Enter
argus keydown app --key a --selector "#input"        # focus first
argus keydown app --code KeyG --print-event          # show resolved key/code/keyCode
argus keydown app --code Backquote --shift           # dispatches key "~", code Backquote
argus keydown app --key a --shift --ctrl             # or --modifiers shift,ctrl,alt,meta (--cmd = --meta)
```

- `--key` is `KeyboardEvent.key`, `--code` is `KeyboardEvent.code`; case-insensitive. Codes: `KeyA–Z`, `Digit0–9`, `F1–12`, `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, arrows, `Home/End/PageUp/PageDown/Insert`, US punctuation row (`Backquote`, `Minus`, `Equal`, `BracketLeft/Right`, `Backslash`, `Semicolon`, `Quote`, `Comma`, `Period`, `Slash`).
- One `keyDown` + one `keyUp`, matching what real presses produce: printable keys (and `Enter`) carry text and fire `keypress`/`input`; non-printing keys go as `rawKeyDown`. `--key Enter` submits a focused form.
- **Focus rule**: Chrome drops keys aimed at an unfocused page but still acks CDP. `keydown` therefore activates a hidden page first (same sticky lock as `page show`) and reports `activated: true`; release with `argus page hide app`. If activation fails it errors `target_not_focused` instead of lying.

## Wait For Navigation

`click` and `keydown` accept `--wait-nav [load|domcontentloaded|none]` (bare flag = `load`) and `--nav-timeout <duration>` (default 10s).

```bash
argus click app --selector "a.next" --wait-nav --json
argus keydown app --key Enter --selector "#search" --wait-nav domcontentloaded --nav-timeout 5s
```

Response gains `navigation: { navigated, url, epoch }`. No navigation is **not** an error: `navigated: false` after the timeout (human output: `(no navigation)`). Only the top frame counts. The `epoch` is opened before the interaction, so `argus logs app --since-epoch <epoch>` reads exactly what followed ([LOGS.md](./LOGS.md)).

## Scroll

```bash
argus scroll-to app --selector "#footer"
argus scroll-to app --to 0,1000
argus scroll-to app --selector ".panel" --by 0,500
argus dom scroll app --selector ".feed" --by 0,300     # real wheel input
```

## Dialogs

A pending `alert`/`confirm`/`prompt`/`beforeunload` blocks CDP (`dialog_blocking`). Handle it with `argus dialog status|accept|dismiss|prompt --text …` ([PAGE.md](./PAGE.md#dialogs)).
