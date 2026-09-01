import { describe, expect, it } from 'bun:test'
import { resolveKeyboardEvent } from '../src/cdp/keyboard.js'

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
