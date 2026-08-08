/**
 * Watcher-side `jsonValue` mode: serialize the result inside the page so the JSON string,
 * not a structured object, crosses the transport.
 *
 * This exists because Chrome's `chrome.debugger` serialization (the extension relay) sorts
 * object keys alphabetically at every nesting level while a direct CDP watcher preserves
 * insertion order — so the same page state yields different bytes per transport.
 */
import { describe, expect, test } from 'bun:test'
import type { CdpEventHandler, CdpSessionHandle } from '../packages/argus-watcher/src/cdp/connection.js'
import { evaluateExpression } from '../packages/argus-watcher/src/cdp/eval.js'

type CannedResult = { result?: unknown; exceptionDetails?: unknown }

class FakeCdpSession implements CdpSessionHandle {
	readonly calls: { method: string; params: Record<string, unknown> }[] = []

	constructor(private readonly canned: Record<string, CannedResult>) {}

	isAttached(): boolean {
		return true
	}

	async sendAndWait(method: string, params?: Record<string, unknown>): Promise<unknown> {
		this.calls.push({ method, params: params ?? {} })
		return this.canned[method] ?? {}
	}

	onEvent(_method: string, _handler: CdpEventHandler): () => void {
		return () => {}
	}

	/** Methods invoked, for asserting that primitives skip the extra round-trip. */
	get methods(): string[] {
		return this.calls.map((call) => call.method)
	}
}

describe('evaluateExpression with jsonValue', () => {
	test('serializes an object inside the page and returns the JSON string', async () => {
		const json = '{"v":{"zebra":1,"apple":2,"nested":{"yy":1,"aa":2}}}'
		const session = new FakeCdpSession({
			'Runtime.evaluate': { result: { type: 'object', objectId: 'obj-1' } },
			'Runtime.callFunctionOn': { result: { type: 'string', value: json } },
		})

		const response = await evaluateExpression(session, { expression: '({zebra:1})', jsonValue: true })

		expect(response.result).toBe(json)
		expect(response.type).toBe('object')
		expect(response.exception).toBeNull()

		const call = session.calls.find((entry) => entry.method === 'Runtime.callFunctionOn')
		expect(call?.params.objectId).toBe('obj-1')
		expect(call?.params.returnByValue).toBe(true)
		expect(String(call?.params.functionDeclaration)).toContain('JSON.stringify')
	})

	test('serializes primitives locally without a second round-trip', async () => {
		const session = new FakeCdpSession({ 'Runtime.evaluate': { result: { type: 'number', value: 42 } } })

		const response = await evaluateExpression(session, { expression: '42', jsonValue: true })

		expect(response.result).toBe('{"v":42}')
		expect(session.methods).not.toContain('Runtime.callFunctionOn')
	})

	test('encodes a genuine undefined as the empty envelope', async () => {
		const session = new FakeCdpSession({ 'Runtime.evaluate': { result: { type: 'undefined' } } })

		const response = await evaluateExpression(session, { expression: 'undefined', jsonValue: true })

		expect(response.result).toBe('{}')
	})

	test('reports a page exception when serialization throws', async () => {
		// Circular structures and throwing `toJSON` hooks surface here.
		const session = new FakeCdpSession({
			'Runtime.evaluate': { result: { type: 'object', objectId: 'obj-1' } },
			'Runtime.callFunctionOn': {
				exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: Converting circular structure to JSON' } },
			},
		})

		const response = await evaluateExpression(session, { expression: 'circular', jsonValue: true })

		expect(response.exception?.text).toBe('Uncaught')
		expect(response.result).toBeNull()
	})

	test('leaves the default path untouched when jsonValue is off', async () => {
		const session = new FakeCdpSession({ 'Runtime.evaluate': { result: { type: 'number', value: 7 } } })

		const response = await evaluateExpression(session, { expression: '7' })

		expect(response.result).toBe(7)
	})

	test('does not alter how the expression is evaluated', async () => {
		const session = new FakeCdpSession({ 'Runtime.evaluate': { result: { type: 'number', value: 1 } } })

		await evaluateExpression(session, { expression: 'const q = 41; q + 1', jsonValue: true, replMode: true })

		// Statement lists and top-level await depend on REPL mode and an unmodified source.
		const evaluate = session.calls.find((entry) => entry.method === 'Runtime.evaluate')
		expect(evaluate?.params.expression).toBe('const q = 41; q + 1')
		expect(evaluate?.params.replMode).toBe(true)
	})
})
