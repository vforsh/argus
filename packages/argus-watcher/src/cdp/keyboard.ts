import { codedError } from '../errors.js'
import type { DomKeydownEvent } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { resolveDomSelectorMatches } from './mouse.js'

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
	for (let i = 1; i <= 12; i++) {
		const name = `F${i}`
		put(name, { key: name, code: name, keyCode: 111 + i })
	}

	return { byKey, byCode }
}

const KEY_MAPS = buildKeyMaps()

/**
 * Resolve a key name to its CDP key definition.
 * Lookup is case-insensitive.
 */
export const resolveKeyDefinition = (key: string): KeyDefinition | undefined => {
	return KEY_MAPS.byKey.get(key.toLowerCase())
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
			throw new Error(`Unknown code: "${codeInput}"`)
		}
		throw new Error(`Unknown key: "${keyInput}"`)
	}

	const key = resolveEventKey(keyInput, baseDef, modifiers)
	const text = resolveEventText(key, baseDef)

	const event: DomKeydownEvent = {
		key,
		code: codeDef?.code ?? codeInput ?? baseDef.code,
		keyCode: baseDef.keyCode,
		modifiers,
		altKey: (modifiers & MODIFIER_BITS.alt) !== 0,
		ctrlKey: (modifiers & MODIFIER_BITS.ctrl) !== 0,
		metaKey: (modifiers & MODIFIER_BITS.meta) !== 0,
		shiftKey: (modifiers & MODIFIER_BITS.shift) !== 0,
	}
	if (text !== undefined) {
		event.text = text
	}
	return event
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

const resolveEventText = (key: string, def: KeyDefinition): string | undefined => {
	if (key.length === 1) {
		return key
	}
	return def.text
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
	const event = resolveKeyboardEvent(options)

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

		const nodeId = nodeIds[0]
		await session.sendAndWait('DOM.focus', { nodeId })
		focused = true
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
	const baseParams = {
		code: event.code,
		key: event.key,
		windowsVirtualKeyCode: event.keyCode,
		modifiers: event.modifiers,
	}

	const keyDownParams = carriesText
		? { ...baseParams, type: 'keyDown' as const, text: event.text, unmodifiedText: event.text }
		: { ...baseParams, type: 'rawKeyDown' as const }

	await session.sendAndWait('Input.dispatchKeyEvent', keyDownParams)
	await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, type: 'keyUp' })

	return { key: event.key, code: event.code, modifiers: event.modifiers, focused, event }
}
