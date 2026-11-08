import { codedError } from '../errors.js'
import type { DomKeydownEvent } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { resolveDomSelectorMatches } from './mouse.js'
import { callFunctionOnNode } from './pageState.js'

// ─────────────────────────────────────────────────────────────────────────────
// Key definitions
// ─────────────────────────────────────────────────────────────────────────────

type KeyDefinition = {
	key: string
	code: string
	keyCode: number
	text?: string
	/** `key` value produced when Shift is held (US layout). Absent for keys Shift does not change. */
	shiftKey?: string
	/** KeyboardEvent.location: 1 left, 2 right, 3 numpad. Absent means standard (0). */
	location?: number
}

type KeyMaps = {
	byKey: Map<string, KeyDefinition>
	byCode: Map<string, KeyDefinition>
}

const buildKeyMaps = (): KeyMaps => {
	const byKey = new Map<string, KeyDefinition>()
	const byCode = new Map<string, KeyDefinition>()

	const put = (lookup: string, def: KeyDefinition): void => {
		byKey.set(lookup.toLowerCase(), def)
		byCode.set(def.code.toLowerCase(), def)
	}

	// Registers a physical key reachable only by its code, so it never shadows an existing key value
	// (`Numpad5` and `Digit5` both produce key "5"; `--key 5` stays the main-row digit).
	const putCode = (def: KeyDefinition): void => {
		byCode.set(def.code.toLowerCase(), def)
	}

	// Common spellings of named keys (`Esc`, `Up`), resolved like the canonical key value.
	const putAlias = (alias: string, canonical: string): void => {
		const def = byKey.get(canonical.toLowerCase())
		if (def) byKey.set(alias.toLowerCase(), def)
	}

	// Lets `--key ~` resolve to the same physical key as `--key \`` without overriding its code lookup.
	const putShiftAlias = (def: KeyDefinition): void => {
		if (def.shiftKey) {
			byKey.set(def.shiftKey.toLowerCase(), def)
		}
	}

	// Letters a-z
	for (let i = 0; i < 26; i++) {
		const lower = String.fromCharCode(97 + i)
		const upper = String.fromCharCode(65 + i)
		const code = `Key${upper}`
		const keyCode = 65 + i
		put(lower, { key: lower, code, keyCode, text: lower })
	}

	// Digits 0-9
	const DIGIT_SHIFT_KEYS = ')!@#$%^&*('
	for (let i = 0; i < 10; i++) {
		const digit = String(i)
		const code = `Digit${digit}`
		const keyCode = 48 + i
		const def: KeyDefinition = { key: digit, code, keyCode, text: digit, shiftKey: DIGIT_SHIFT_KEYS[i] }
		put(digit, def)
		putShiftAlias(def)
	}

	// Punctuation (US layout): standard KeyboardEvent.code values with their legacy keyCodes
	const PUNCTUATION: Array<[code: string, key: string, shiftKey: string, keyCode: number]> = [
		['Backquote', '`', '~', 192],
		['Minus', '-', '_', 189],
		['Equal', '=', '+', 187],
		['BracketLeft', '[', '{', 219],
		['BracketRight', ']', '}', 221],
		['Backslash', '\\', '|', 220],
		['Semicolon', ';', ':', 186],
		['Quote', "'", '"', 222],
		['Comma', ',', '<', 188],
		['Period', '.', '>', 190],
		['Slash', '/', '?', 191],
	]
	for (const [code, key, shiftKey, keyCode] of PUNCTUATION) {
		const def: KeyDefinition = { key, code, keyCode, text: key, shiftKey }
		put(key, def)
		putShiftAlias(def)
	}

	// Special keys
	put('Enter', { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
	put('Tab', { key: 'Tab', code: 'Tab', keyCode: 9 })
	put('Escape', { key: 'Escape', code: 'Escape', keyCode: 27 })
	put('Backspace', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
	put('Delete', { key: 'Delete', code: 'Delete', keyCode: 46 })
	put('Space', { key: ' ', code: 'Space', keyCode: 32, text: ' ' })
	put(' ', { key: ' ', code: 'Space', keyCode: 32, text: ' ' })

	// Arrows
	put('ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 })
	put('ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 })
	put('ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
	put('ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 })

	// Navigation
	put('Home', { key: 'Home', code: 'Home', keyCode: 36 })
	put('End', { key: 'End', code: 'End', keyCode: 35 })
	put('PageUp', { key: 'PageUp', code: 'PageUp', keyCode: 33 })
	put('PageDown', { key: 'PageDown', code: 'PageDown', keyCode: 34 })
	put('Insert', { key: 'Insert', code: 'Insert', keyCode: 45 })

	// F-keys
	for (let i = 1; i <= 24; i++) {
		const name = `F${i}`
		put(name, { key: name, code: name, keyCode: 111 + i })
	}

	// Numpad (NumLock on): digits and operators produce the same key values as the main keys.
	for (let i = 0; i <= 9; i++) {
		putCode({ key: String(i), code: `Numpad${i}`, keyCode: 96 + i, text: String(i), location: 3 })
	}
	const NUMPAD: Array<[code: string, key: string, keyCode: number]> = [
		['NumpadMultiply', '*', 106],
		['NumpadAdd', '+', 107],
		['NumpadSubtract', '-', 109],
		['NumpadDecimal', '.', 110],
		['NumpadDivide', '/', 111],
		['NumpadEqual', '=', 187],
		['NumpadComma', ',', 188],
	]
	for (const [code, key, keyCode] of NUMPAD) {
		putCode({ key, code, keyCode, text: key, location: 3 })
	}
	putCode({ key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r', location: 3 })

	// Modifiers and locks. `--key Shift` is the left key; the right one is reachable by code.
	put('Shift', { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 })
	putCode({ key: 'Shift', code: 'ShiftRight', keyCode: 16, location: 2 })
	put('Control', { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 })
	putCode({ key: 'Control', code: 'ControlRight', keyCode: 17, location: 2 })
	put('Alt', { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 })
	putCode({ key: 'Alt', code: 'AltRight', keyCode: 18, location: 2 })
	put('Meta', { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 })
	putCode({ key: 'Meta', code: 'MetaRight', keyCode: 92, location: 2 })
	put('CapsLock', { key: 'CapsLock', code: 'CapsLock', keyCode: 20 })
	put('NumLock', { key: 'NumLock', code: 'NumLock', keyCode: 144 })
	put('ScrollLock', { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 })
	put('Pause', { key: 'Pause', code: 'Pause', keyCode: 19 })
	put('PrintScreen', { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 })
	put('ContextMenu', { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 })

	putAlias('Esc', 'Escape')
	putAlias('Return', 'Enter')
	putAlias('Del', 'Delete')
	putAlias('Spacebar', 'Space')
	putAlias('Up', 'ArrowUp')
	putAlias('Down', 'ArrowDown')
	putAlias('Left', 'ArrowLeft')
	putAlias('Right', 'ArrowRight')
	putAlias('Ctrl', 'Control')
	putAlias('Cmd', 'Meta')
	putAlias('Option', 'Alt')

	return { byKey, byCode }
}

const KEY_MAPS = buildKeyMaps()

/**
 * Resolve a key name to its CDP key definition. Lookup is case-insensitive.
 *
 * Accepts a KeyboardEvent.key value (`a`, `1`, `Enter`) or, failing that, a KeyboardEvent.code name
 * (`KeyA`, `Digit1`, `Numpad5`). Agents read both spellings off DOM events and pass them interchangeably;
 * `--key Digit1` used to fail with `Unknown key` although `--code Digit1` worked. Key values win, so a
 * name that is both (`Enter`, `F1`) keeps its key meaning.
 */
export const resolveKeyDefinition = (key: string): KeyDefinition | undefined => {
	const lookup = key.toLowerCase()
	return KEY_MAPS.byKey.get(lookup) ?? KEY_MAPS.byCode.get(lookup)
}

/** Resolve a physical KeyboardEvent.code to its CDP key definition. */
export const resolveCodeDefinition = (code: string): KeyDefinition | undefined => {
	return KEY_MAPS.byCode.get(code.toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// Modifier parser
// ─────────────────────────────────────────────────────────────────────────────

/** CDP modifier bitmask values. */
const MODIFIER_BITS: Record<string, number> = {
	alt: 1,
	ctrl: 2,
	control: 2,
	meta: 4,
	cmd: 4,
	command: 4,
	shift: 8,
}

/**
 * Parse a comma-separated modifier string into a CDP bitmask.
 * Accepts aliases: ctrl/control, meta/cmd/command.
 * Returns 0 for undefined/empty input.
 */
export const parseModifiers = (input?: string): number => {
	if (!input || input.trim() === '') {
		return 0
	}

	let mask = 0
	const parts = input.split(',')
	for (const part of parts) {
		const name = part.trim().toLowerCase()
		if (name === '') {
			continue
		}
		const bit = MODIFIER_BITS[name]
		if (bit == null) {
			throw new Error(`Unknown modifier: "${part.trim()}"`)
		}
		mask |= bit
	}

	return mask
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch keydown
// ─────────────────────────────────────────────────────────────────────────────

export type DispatchKeydownOptions = {
	key?: string
	code?: string
	selector?: string
	modifiers?: number
}

export type DispatchKeydownResult = {
	key: string
	code: string
	modifiers: number
	focused: boolean
	event: DomKeydownEvent
}

type ResolveKeyboardEventOptions = {
	key?: string
	code?: string
	modifiers?: number
}

/** Resolve user-facing key/code input into the exact event shape sent to Chrome. */
export const resolveKeyboardEvent = (options: ResolveKeyboardEventOptions): DomKeydownEvent => {
	const modifiers = options.modifiers ?? 0
	const keyInput = normalizeOptionalString(options.key)
	const codeInput = normalizeOptionalString(options.code)

	if (!keyInput && !codeInput) {
		throw new Error('key or code is required')
	}

	const keyDef = keyInput ? resolveKeyDefinition(keyInput) : undefined
	const codeDef = codeInput ? resolveCodeDefinition(codeInput) : undefined
	const baseDef = codeDef ?? keyDef

	if (!baseDef) {
		if (codeInput && !keyInput) {
			throw new Error(unknownKeyMessage('code', codeInput))
		}
		throw new Error(unknownKeyMessage('key', keyInput!))
	}

	// The key value comes from `--key` when given, `--code` only fills it in. A typed character (`a`, `~`) is kept
	// verbatim; a known name resolves to its canonical key, since Chrome blanks key values it does not know
	// (`--key Esc`, `--key KeyA`, `--key enter` must reach the page as `Escape`, `a`, `Enter`). A name outside the
	// table that came with a code (`Dead`, `Unidentified` from a recording) passes through without text.
	const keySource = keyDef ?? baseDef
	const verbatimKey = keyInput && (keyInput.length === 1 || !keyDef) ? keyInput : undefined
	const key = resolveEventKey(verbatimKey, keySource, modifiers)
	const text = resolveEventText(key, keyInput && !keyDef ? undefined : keySource)

	const event = withModifiers({ key, code: codeDef?.code ?? codeInput ?? baseDef.code, keyCode: baseDef.keyCode }, modifiers)
	if (text !== undefined) {
		event.text = text
	}
	if (baseDef.location) {
		event.location = baseDef.location
	}
	return event
}

/**
 * `Unknown key: "Digt1". Did you mean: Digit1, Digit7?` plus what the flag accepts.
 * Suggestions come from every key value and code name, ranked by edit distance.
 */
const unknownKeyMessage = (kind: 'key' | 'code', input: string): string => {
	const accepts =
		kind === 'key'
			? 'Use a KeyboardEvent.key value (a, 1, Enter, ArrowUp) or code name (KeyA, Digit1, Numpad5).'
			: 'Use a KeyboardEvent.code name (KeyA, Digit1, Numpad5, ArrowUp).'
	const suggestions = suggestKeyNames(input, kind)
	const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ''
	return `Unknown ${kind}: "${input}".${hint} ${accepts}`
}

const suggestKeyNames = (input: string, kind: 'key' | 'code'): string[] => {
	const lookup = input.toLowerCase()
	const names = new Set<string>()
	for (const def of KEY_MAPS.byCode.values()) {
		names.add(def.code)
		if (kind === 'key' && def.key.length > 1) names.add(def.key)
	}
	const ranked = [...names].map((name) => ({ name, distance: editDistance(lookup, name.toLowerCase()) }))
	// Closest names only: a typo one edit from `Digit1` should not also list the nine other digits.
	const best = Math.min(...ranked.map(({ distance }) => distance))
	const close = best <= Math.max(2, Math.floor(lookup.length / 3)) ? ranked.filter(({ distance }) => distance === best) : []
	const matches = close.length > 0 ? close : ranked.filter(({ name }) => lookup.length >= 3 && name.toLowerCase().includes(lookup))
	return matches
		.map(({ name }) => name)
		.sort()
		.slice(0, 5)
}

const editDistance = (a: string, b: string): number => {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
	for (let i = 1; i <= a.length; i++) {
		const current = [i]
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
		}
		previous = current
	}
	return previous[b.length]!
}

const normalizeOptionalString = (value: string | undefined): string | undefined => {
	const normalized = value?.trim()
	return normalized ? normalized : undefined
}

const resolveEventKey = (keyInput: string | undefined, def: KeyDefinition, modifiers: number): string => {
	const semanticKey = keyInput ?? def.key
	if (isSingleLetter(semanticKey)) {
		return isShift(modifiers) ? semanticKey.toUpperCase() : semanticKey.toLowerCase()
	}
	// Only shift the unshifted form: an explicit `--key ~` already names the shifted character.
	if (isShift(modifiers) && def.shiftKey && semanticKey === def.key) {
		return def.shiftKey
	}
	return semanticKey
}

const resolveEventText = (key: string, def: KeyDefinition | undefined): string | undefined => {
	if (key.length === 1) {
		return key
	}
	return def?.text
}

const isSingleLetter = (value: string): boolean => /^[a-z]$/i.test(value)

const isShift = (modifiers: number): boolean => (modifiers & MODIFIER_BITS.shift) !== 0

/**
 * Dispatch a keyboard event sequence via CDP Input.dispatchKeyEvent.
 *
 * 1. If `selector` provided: resolve → error if 0 or >1 match → focus
 * 2. Resolve key definition
 * 3. Dispatch: keys that carry text → keyDown(text)+keyUp; the rest → rawKeyDown+keyUp
 *
 * A `keyDown` carrying `text` already produces the character, so no separate `char` event is
 * sent. Sending one used to double every printable key: the page saw one `keydown`, but two
 * `keypress`/`beforeinput`/`input` rounds, and a focused field ended up with "99" for a single
 * `--key 9`. Chrome's own automation clients (Playwright) dispatch the same two events.
 */
export const dispatchKeydown = async (session: CdpSessionHandle, options: DispatchKeydownOptions): Promise<DispatchKeydownResult> => {
	const { selector } = options
	const resolved = resolveKeyboardEvent(options)
	// A held modifier is part of its own keydown (`keydown Shift` reports shiftKey: true) and released by its keyup.
	const ownModifier = MODIFIER_KEY_BITS[resolved.key] ?? 0
	const event = withModifiers(resolved, resolved.modifiers | ownModifier)

	let focused = false

	// 1. Focus selector if provided
	if (selector) {
		const { allNodeIds, nodeIds } = await resolveDomSelectorMatches(session, selector, false)

		if (allNodeIds.length === 0) {
			throw new Error(`No element found for selector: ${selector}`)
		}

		if (allNodeIds.length > 1) {
			throw codedError('multiple_matches', `Selector matched ${allNodeIds.length} elements; keydown requires exactly one target`)
		}

		focused = await focusKeyTarget(session, nodeIds[0]!)
	}

	// `rawKeyDown` is Chrome's "this key produces no character" type: it suppresses `keypress` and
	// every default text action. Enter carries text (`\r`) but was excluded from this split, so
	// `--key Enter` reached the page as a bare keydown/keyup pair — no newline in a textarea, no
	// form submission. The split is simply whether the key produces text, as Playwright decides it.
	const carriesText = event.text != null

	// 3. Dispatch key events
	//
	// `nativeVirtualKeyCode` is deliberately absent: it means the *platform's* key code — a Carbon
	// keycode on macOS, an X11 keysym on Linux — and Argus only knows the Windows one, so the value
	// was always wrong off Windows. Chrome 152 headless turns that into a hang, repeating the key
	// thousands of times a second until the renderer stops answering CDP. `windowsVirtualKeyCode`
	// alone is what reaches the page as `KeyboardEvent.keyCode`, and it is all Playwright sends.
	// CDP's `location` only knows left (1) and right (2); numpad keys travel as `isKeypad`.
	const baseParams = {
		code: event.code,
		key: event.key,
		windowsVirtualKeyCode: event.keyCode,
		modifiers: event.modifiers,
		...(event.location === NUMPAD_LOCATION ? { isKeypad: true } : event.location ? { location: event.location } : {}),
	}

	const keyDownParams = carriesText
		? { ...baseParams, type: 'keyDown' as const, text: event.text, unmodifiedText: event.text }
		: { ...baseParams, type: 'rawKeyDown' as const }

	await session.sendAndWait('Input.dispatchKeyEvent', keyDownParams)
	await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, modifiers: event.modifiers & ~ownModifier, type: 'keyUp' })

	return { key: event.key, code: event.code, modifiers: event.modifiers, focused, event }
}

const NUMPAD_LOCATION = 3

/** Modifier bit each modifier key sets while it is down. */
const MODIFIER_KEY_BITS: Record<string, number> = {
	Alt: MODIFIER_BITS.alt,
	Control: MODIFIER_BITS.ctrl,
	Meta: MODIFIER_BITS.meta,
	Shift: MODIFIER_BITS.shift,
}

type ModifierFields = 'modifiers' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'

const withModifiers = (event: Omit<DomKeydownEvent, ModifierFields>, modifiers: number): DomKeydownEvent => ({
	...event,
	modifiers,
	altKey: (modifiers & MODIFIER_BITS.alt) !== 0,
	ctrlKey: (modifiers & MODIFIER_BITS.ctrl) !== 0,
	metaKey: (modifiers & MODIFIER_BITS.meta) !== 0,
	shiftKey: (modifiers & MODIFIER_BITS.shift) !== 0,
})

/**
 * Focus the `--selector` target the way a click would, returning whether it took focus.
 *
 * A canvas or plain element without tabindex cannot take focus: clicking it leaves the document focused, so
 * real keys reach `<body>` and bubble to the window/document listeners games use. `DOM.focus` throws
 * "Element is not focusable" there, which failed `keydown --selector canvas` outright; instead the target's frame
 * takes focus (a click inside an iframe moves focus into it, away from a focused input in the parent) and its
 * focused element is released, so the key lands where a user's would.
 */
const RELEASE_FOCUS_TO_FRAME = `function() {
	const doc = this.ownerDocument
	doc.defaultView?.focus()
	const active = doc.activeElement
	if (active && active !== doc.body) active.blur()
}`

const focusKeyTarget = async (session: CdpSessionHandle, nodeId: number): Promise<boolean> => {
	try {
		await session.sendAndWait('DOM.focus', { nodeId })
		return true
	} catch (error) {
		if (!/not focusable/i.test(error instanceof Error ? error.message : String(error))) throw error
	}
	await callFunctionOnNode(session, { nodeId }, { code: RELEASE_FOCUS_TO_FRAME })
	return false
}
