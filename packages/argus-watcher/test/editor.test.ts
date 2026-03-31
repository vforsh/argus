import { describe, expect, it } from 'bun:test'
import type { CdpEventHandler, CdpEventMeta, CdpSessionHandle } from '../src/cdp/connection.js'
import { createRuntimeEditor } from '../src/cdp/editor.js'

describe('runtime editor grep', () => {
	it('skips stale stylesheet handles and evicts them from the resource inventory', async () => {
		const stub = createSessionStub()
		stub.setSendHandler(async (method, params) => {
			switch (method) {
				case 'Debugger.enable':
					stub.emit('Debugger.scriptParsed', {
						scriptId: 'script-1',
						url: 'https://example.com/app.js',
					})
					return {}
				case 'DOM.enable':
					return {}
				case 'CSS.enable':
					stub.emit('CSS.styleSheetAdded', {
						header: {
							styleSheetId: 'style-1',
							sourceURL: 'https://example.com/app.css',
						},
					})
					return {}
				case 'Debugger.getScriptSource':
					expect(params).toEqual({ scriptId: 'script-1' })
					return {
						scriptSource: 'const showLogsByHost = "/admin/api/showLogsByHost"',
					}
				case 'CSS.getStyleSheetText':
					expect(params).toEqual({ styleSheetId: 'style-1' })
					throw new Error('No style sheet with given id found')
				default:
					throw new Error(`Unexpected CDP method: ${method}`)
			}
		})

		const editor = createRuntimeEditor(stub.session)
		const response = await editor.grep({ pattern: 'showLogsByHost' })

		expect(response.matches).toEqual([
			{
				url: 'https://example.com/app.js#argus-resource=script-1',
				type: 'script',
				lineNumber: 1,
				lineContent: 'const showLogsByHost = "/admin/api/showLogsByHost"',
			},
		])
		expect(response.skippedResources).toEqual([
			{
				url: 'https://example.com/app.css#argus-resource=style-1',
				type: 'stylesheet',
				reason: 'No style sheet with given id found',
			},
		])

		const resources = await editor.list()
		expect(resources.resources).toEqual([
			{
				url: 'https://example.com/app.js#argus-resource=script-1',
				type: 'script',
			},
		])
	})

	it('still surfaces non-stale CDP read failures', async () => {
		const stub = createSessionStub()
		stub.setSendHandler(async (method) => {
			switch (method) {
				case 'Debugger.enable':
					stub.emit('Debugger.scriptParsed', {
						scriptId: 'script-1',
						url: 'https://example.com/app.js',
					})
					return {}
				case 'DOM.enable':
					return {}
				case 'CSS.enable':
					stub.emit('CSS.styleSheetAdded', {
						header: {
							styleSheetId: 'style-1',
							sourceURL: 'https://example.com/app.css',
						},
					})
					return {}
				case 'CSS.getStyleSheetText':
					throw new Error('Target closed')
				default:
					return {}
			}
		})

		const editor = createRuntimeEditor(stub.session)
		await expect(editor.grep({ pattern: 'showLogsByHost' })).rejects.toThrow('Target closed')
	})
})

const createSessionStub = () => {
	const handlers = new Map<string, Set<CdpEventHandler>>()
	let sendHandler: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async (method) => {
		throw new Error(`Unexpected CDP method: ${method}`)
	}

	const session: CdpSessionHandle = {
		isAttached: () => true,
		sendAndWait: (method, params) => sendHandler(method, params),
		onEvent: (method, handler) => {
			let bucket = handlers.get(method)
			if (!bucket) {
				bucket = new Set()
				handlers.set(method, bucket)
			}

			bucket.add(handler)
			return () => {
				bucket?.delete(handler)
			}
		},
		getTargetContext: () => ({ kind: 'page' }),
	}

	return {
		session,
		setSendHandler: (nextHandler: typeof sendHandler) => {
			sendHandler = nextHandler
		},
		emit: (method: string, params: unknown, meta: CdpEventMeta = { sessionId: null }) => {
			for (const handler of handlers.get(method) ?? []) {
				handler(params, meta)
			}
		},
	}
}
