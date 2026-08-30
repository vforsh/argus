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

	// Letters a-z
	for (let i = 0; i < 26; i++) {
		const lower = String.fromCharCode(97 + i)
		const upper = String.fromCharCode(65 + i)
		const code = `Key${upper}`
		const keyCode = 65 + i
		put(lower, { key: lower, code, keyCode, text: lower })
	}

	// Digits 0-9
	for (let i = 0; i < 10; i++) {
		const digit = String(i)
		const code = `Digit${digit}`
		const keyCode = 48 + i
		put(digit, { key: digit, code, keyCode, text: digit })
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
		code: codeInput ?? baseDef.code,
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
 * 3. Dispatch: printable → keyDown+char+keyUp; non-printable → rawKeyDown+keyUp
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

	const isPrintable = event.text != null && event.text !== '\r'

	// 3. Dispatch key events
	const baseParams = {
		code: event.code,
		key: event.key,
		windowsVirtualKeyCode: event.keyCode,
		nativeVirtualKeyCode: event.keyCode,
		modifiers: event.modifiers,
	}

	if (isPrintable) {
		await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, type: 'keyDown', text: event.text })
		await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, type: 'char', text: event.text })
		await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, type: 'keyUp' })
	} else {
		await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, type: 'rawKeyDown', text: event.text })
		await session.sendAndWait('Input.dispatchKeyEvent', { ...baseParams, type: 'keyUp' })
	}

	return { key: event.key, code: event.code, modifiers: event.modifiers, focused, event }
}
