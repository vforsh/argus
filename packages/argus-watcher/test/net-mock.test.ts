import { describe, expect, it } from 'bun:test'
import type { CdpEventHandler, CdpSendOptions, CdpSessionHandle } from '../src/cdp/connection.js'
import { createNetMockController } from '../src/net/NetMockController.js'

type SentCommand = {
	method: string
	params: Record<string, unknown> | undefined
	options: CdpSendOptions | undefined
}

describe('net mock target scope', () => {
	it('routes selected rules through the selected child session and follows target changes', async () => {
		const cdp = createFakeSession()
		let selected = { frameId: 'frame-game-1', topFrameId: 'frame-root', sessionId: 'child-1' }
		const controller = createNetMockController()
		controller.bind({ pageSession: cdp.session, getSelectedTarget: () => selected })

		const added = await controller.addRule(
			{
				scope: 'selected',
				match: { url: '*/api/rating', method: 'POST', resourceType: 'Fetch' },
				action: { kind: 'fulfill', status: 200, bodyBase64: Buffer.from('{"ok":true}').toString('base64') },
			},
			true,
		)

		expect(added.enabled).toBe(true)
		expect(cdp.commands.at(-1)).toMatchObject({ method: 'Fetch.enable', options: { sessionId: 'child-1' } })

		cdp.emitPaused({ requestId: 'page-request', frameId: 'frame-root' }, { sessionId: null })
		await settleEvents()
		expect(cdp.commands.at(-1)).toMatchObject({ method: 'Fetch.continueRequest', params: { requestId: 'page-request' }, options: undefined })
		expect(controller.getStatus({ attached: true }).rules[0]?.hits).toBe(0)

		cdp.emitPaused({ requestId: 'selected-request', frameId: 'frame-game-1' }, { sessionId: 'child-1' })
		await settleEvents()
		expect(cdp.commands.at(-1)).toMatchObject({
			method: 'Fetch.fulfillRequest',
			params: { requestId: 'selected-request', responseCode: 200 },
			options: { sessionId: 'child-1' },
		})
		expect(controller.getStatus({ attached: true }).rules[0]?.hits).toBe(1)

		selected = { frameId: 'frame-game-2', topFrameId: 'frame-root', sessionId: 'child-2' }
		await controller.onTargetChanged()
		expect(cdp.commands.slice(-2)).toEqual([
			{ method: 'Fetch.disable', params: {}, options: { sessionId: 'child-1' } },
			{
				method: 'Fetch.enable',
				params: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
				options: { sessionId: 'child-2' },
			},
		])
	})

	it('filters a same-process selected iframe by frame id on the page session', async () => {
		const cdp = createFakeSession()
		const controller = createNetMockController()
		controller.bind({
			pageSession: cdp.session,
			getSelectedTarget: () => ({ frameId: 'frame-game', topFrameId: 'frame-root', sessionId: null }),
		})
		await controller.addRule(
			{
				scope: 'selected',
				match: { url: '*/api/rating' },
				action: { kind: 'block' },
			},
			true,
		)

		expect(cdp.commands.at(-1)).toMatchObject({ method: 'Fetch.enable', options: undefined })

		cdp.emitPaused({ requestId: 'other-frame', frameId: 'frame-other' })
		cdp.emitPaused({ requestId: 'selected-frame', frameId: 'frame-game' })
		await settleEvents()

		expect(cdp.commands.slice(-2)).toEqual([
			{ method: 'Fetch.continueRequest', params: { requestId: 'other-frame' }, options: undefined },
			{ method: 'Fetch.failRequest', params: { requestId: 'selected-frame', errorReason: 'BlockedByClient' }, options: undefined },
		])
	})

	it('re-arms selected interception after the source reattaches', async () => {
		const cdp = createFakeSession()
		const controller = createNetMockController()
		controller.bind({
			pageSession: cdp.session,
			getSelectedTarget: () => ({ frameId: 'frame-game', topFrameId: 'frame-root', sessionId: 'child-1' }),
		})
		await controller.addRule({ scope: 'selected', match: { url: '*/api/config' }, action: { kind: 'block' } }, true)

		cdp.commands.length = 0
		controller.onDetach()
		await controller.onAttach()

		expect(cdp.commands).toEqual([
			{
				method: 'Fetch.enable',
				params: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
				options: { sessionId: 'child-1' },
			},
		])
	})

	it('ignores stale child-session errors while moving interception to a replacement iframe', async () => {
		const cdp = createFakeSession((method, options) =>
			method === 'Fetch.disable' && options?.sessionId === 'child-1'
				? new Error('{"code":-32001,"message":"Session with given id not found."}')
				: null,
		)
		let selected = { frameId: 'frame-game-1', topFrameId: 'frame-root', sessionId: 'child-1' }
		const controller = createNetMockController()
		controller.bind({ pageSession: cdp.session, getSelectedTarget: () => selected })
		await controller.addRule({ scope: 'selected', match: { url: '*/api/config' }, action: { kind: 'block' } }, true)

		selected = { frameId: 'frame-game-2', topFrameId: 'frame-root', sessionId: 'child-2' }
		await controller.onTargetChanged()

		expect(cdp.commands.at(-1)).toMatchObject({ method: 'Fetch.enable', options: { sessionId: 'child-2' } })
		expect(controller.getStatus({ attached: true }).lastError).toBeNull()
	})

	it('serializes rapid target changes so only the latest iframe remains enabled', async () => {
		let releaseDisable = (): void => undefined
		let delayOldDisable = false
		const disableGate = new Promise<void>((resolve) => {
			releaseDisable = resolve
		})
		const cdp = createFakeSession(async (method, options) => {
			if (delayOldDisable && method === 'Fetch.disable' && options?.sessionId === 'child-1') {
				await disableGate
			}
			return null
		})
		let selected = { frameId: 'frame-game-1', topFrameId: 'frame-root', sessionId: 'child-1' }
		const controller = createNetMockController()
		controller.bind({ pageSession: cdp.session, getSelectedTarget: () => selected })
		await controller.addRule({ scope: 'selected', match: { url: '*/api/config' }, action: { kind: 'block' } }, true)

		delayOldDisable = true
		selected = { frameId: 'frame-game-2', topFrameId: 'frame-root', sessionId: 'child-2' }
		const firstChange = controller.onTargetChanged()
		await settleEvents()
		selected = { frameId: 'frame-game-3', topFrameId: 'frame-root', sessionId: 'child-3' }
		const secondChange = controller.onTargetChanged()
		releaseDisable()
		await Promise.all([firstChange, secondChange])

		expect(cdp.commands.slice(-4)).toEqual([
			{ method: 'Fetch.disable', params: {}, options: { sessionId: 'child-1' } },
			{
				method: 'Fetch.enable',
				params: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
				options: { sessionId: 'child-2' },
			},
			{ method: 'Fetch.disable', params: {}, options: { sessionId: 'child-2' } },
			{
				method: 'Fetch.enable',
				params: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
				options: { sessionId: 'child-3' },
			},
		])
	})
})

const createFakeSession = (
	failCommand?: (method: string, options: CdpSendOptions | undefined) => Error | null | Promise<Error | null>,
): {
	session: CdpSessionHandle
	commands: SentCommand[]
	emitPaused: (overrides?: Record<string, unknown>, meta?: { sessionId?: string | null }) => void
} => {
	const commands: SentCommand[] = []
	const handlers = new Map<string, Set<CdpEventHandler>>()
	const session: CdpSessionHandle = {
		isAttached: () => true,
		sendAndWait: async (method, params, options) => {
			commands.push({ method, params, options })
			const error = await failCommand?.(method, options)
			if (error) {
				throw error
			}
			return {}
		},
		onEvent: (method, handler) => {
			const bucket = handlers.get(method) ?? new Set<CdpEventHandler>()
			const erased = handler as CdpEventHandler
			bucket.add(erased)
			handlers.set(method, bucket)
			return () => bucket.delete(erased)
		},
		getTargetContext: () => ({ kind: 'page' as const }),
		getReadyTargetContext: async () => ({ kind: 'page' as const }),
	}

	return {
		session,
		commands,
		emitPaused: (overrides = {}, meta = {}) => {
			const params = {
				requestId: 'request-1',
				request: { url: 'https://example.test/api/rating', method: 'POST', headers: {} },
				resourceType: 'Fetch',
				frameId: 'frame-root',
				...overrides,
			}
			for (const handler of handlers.get('Fetch.requestPaused') ?? []) {
				handler(params, { sessionId: meta.sessionId ?? null })
			}
		},
	}
}

const settleEvents = async (): Promise<void> => {
	await Bun.sleep(0)
}
