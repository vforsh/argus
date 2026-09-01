import { describe, expect, it } from 'bun:test'
import type { CdpSessionHandle } from '../src/cdp/connection.js'
import { dispatchKeydown, resolveKeyboardEvent } from '../src/cdp/keyboard.js'

const SHIFT = 8

describe('resolveKeyboardEvent punctuation', () => {
	it('resolves Backquote without shift', () => {
		expect(resolveKeyboardEvent({ code: 'Backquote' })).toMatchObject({
			key: '`',
			code: 'Backquote',
			keyCode: 192,
			text: '`',
			shiftKey: false,
		})
	})

	it('resolves Backquote with shift to the tilde', () => {
		expect(resolveKeyboardEvent({ code: 'Backquote', modifiers: SHIFT })).toMatchObject({
			key: '~',
			code: 'Backquote',
			keyCode: 192,
			text: '~',
			shiftKey: true,
		})
	})

	it('resolves the backquote character to its physical code', () => {
		expect(resolveKeyboardEvent({ key: '`' })).toMatchObject({ key: '`', code: 'Backquote', keyCode: 192 })
	})

	it('keeps an explicitly requested shifted character as-is', () => {
		expect(resolveKeyboardEvent({ key: '~' })).toMatchObject({ key: '~', code: 'Backquote', keyCode: 192 })
		expect(resolveKeyboardEvent({ key: '~', modifiers: SHIFT })).toMatchObject({ key: '~', code: 'Backquote' })
	})

	it('normalizes the reported code to its canonical casing', () => {
		expect(resolveKeyboardEvent({ code: 'backquote' }).code).toBe('Backquote')
	})

	it('covers the rest of the punctuation row', () => {
		const cases: Array<[code: string, key: string, shifted: string, keyCode: number]> = [
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

		for (const [code, key, shifted, keyCode] of cases) {
			expect(resolveKeyboardEvent({ code })).toMatchObject({ key, code, keyCode, text: key })
			expect(resolveKeyboardEvent({ code, modifiers: SHIFT })).toMatchObject({ key: shifted, code, keyCode, text: shifted })
		}
	})

	it('shifts digits to their symbol row', () => {
		expect(resolveKeyboardEvent({ code: 'Digit1', modifiers: SHIFT })).toMatchObject({ key: '!', code: 'Digit1', keyCode: 49 })
		expect(resolveKeyboardEvent({ code: 'Digit0', modifiers: SHIFT })).toMatchObject({ key: ')', code: 'Digit0', keyCode: 48 })
		expect(resolveKeyboardEvent({ code: 'Digit1' })).toMatchObject({ key: '1', text: '1' })
	})

	it('still rejects an unknown code', () => {
		expect(() => resolveKeyboardEvent({ code: 'NoSuchCode' })).toThrow(/Unknown code: "NoSuchCode"/)
	})

	it('keeps a custom code when paired with a known key', () => {
		expect(resolveKeyboardEvent({ key: 'Enter', code: 'NumpadEnter' })).toMatchObject({ key: 'Enter', code: 'NumpadEnter', keyCode: 13 })
	})
})

/**
 * These pin the exact CDP traffic, because both of the bugs they guard against were invisible in
 * the response: the command reported a clean dispatch either way, and only the page could tell.
 */
describe('dispatchKeydown wire shape', () => {
	it('never sends nativeVirtualKeyCode', async () => {
		// Argus only knows the Windows key code; sending it as the *native* one is wrong on macOS and
		// Linux, and Chrome 152 headless answers a printable keyDown carrying a foreign native code
		// with an unbounded key repeat that wedges the renderer.
		const { calls } = await captureDispatch({ key: '9' })

		for (const [, params] of calls) {
			expect(params).not.toHaveProperty('nativeVirtualKeyCode')
			expect(params.windowsVirtualKeyCode).toBe(57)
		}
	})

	it('sends one keyDown carrying the text, then keyUp — no separate char', async () => {
		// A keyDown with `text` already produces the character; the extra `char` event doubled every
		// printable key, so a single `--key 9` typed "99" into a focused field.
		const { calls } = await captureDispatch({ key: '9' })

		expect(calls.map(([, params]) => params.type)).toEqual(['keyDown', 'keyUp'])
		expect(calls[0][1]).toMatchObject({ type: 'keyDown', text: '9', unmodifiedText: '9', key: '9', code: 'Digit9' })
		expect(calls[1][1].text).toBeUndefined()
	})

	it('keeps non-printable keys on the rawKeyDown path', async () => {
		const { calls } = await captureDispatch({ key: 'ArrowUp' })

		expect(calls.map(([, params]) => params.type)).toEqual(['rawKeyDown', 'keyUp'])
		expect(calls[0][1]).toMatchObject({ key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 })
	})
})

type DispatchCall = [method: string, params: Record<string, unknown>]

const captureDispatch = async (options: { key?: string; code?: string }): Promise<{ calls: DispatchCall[] }> => {
	const calls: DispatchCall[] = []
	const session = {
		isAttached: () => true,
		sendAndWait: (async (method: string, params?: Record<string, unknown>) => {
			if (method === 'Input.dispatchKeyEvent') {
				calls.push([method, params ?? {}])
			}
			return {}
		}) as CdpSessionHandle['sendAndWait'],
		onEvent: () => () => {},
		getTargetContext: () => ({ kind: 'page' as const }),
		getReadyTargetContext: async () => ({ kind: 'page' as const }),
	}

	await dispatchKeydown(session, options)
	return { calls }
}
