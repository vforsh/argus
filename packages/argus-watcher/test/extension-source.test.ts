import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as nativeMessaging from '../src/native-messaging/messaging.js'
import type { ExtensionToTabHost, TabHostToExtension } from '../src/native-messaging/types.js'
import { createExtensionSource } from '../src/sources/extension-source.js'
import type { CdpSourceHandle, CdpSourceStatus } from '../src/sources/types.js'
import { getDomRootId } from '../src/cdp/dom/selector.js'
import { createVisualCapturePlan } from '../src/cdp/visualCapture.js'
import { createSourcemapResolver } from '../src/sourcemaps/sourcemapResolver.js'
import type { CdpMethod } from '../src/cdp/protocol.js'

let source: CdpSourceHandle | undefined
let messagingSpy: ReturnType<typeof spyOn> | undefined

afterEach(async () => {
	await source?.stop()
	source = undefined
	messagingSpy?.mockRestore()
})

describe('extension source selected-frame recovery', () => {
	it('never sends selected commands to the host during the real detach/reconcile window', async () => {
		const harness = await createHarness()
		await source!.attachTarget!('frame:1:old')
		harness.detach()
		// A subsequent root navigation reconciles again while the iframe is still missing.
		harness.emit('Page.frameNavigated', { frame: { id: 'root', url: 'https://host.test/app' } })

		expect(source!.session.getTargetContext?.()).toMatchObject({ kind: 'frame', frameId: 'old' })
		expect(harness.statuses.at(-1)).toMatchObject({ targetReady: false, target: { type: 'iframe', url: 'https://game.test/embed?token=old' } })
		expect(await source!.listTargets!()).toMatchObject([
			{ id: 'tab:1', attached: false },
			{ id: 'frame:1:old', attached: true, targetReady: false },
		])

		const methods: CdpMethod[] = ['Runtime.evaluate', 'DOM.getDocument', 'Page.captureScreenshot']
		const results = await Promise.allSettled([
			...methods.map((method) => source!.session.sendAndWait(method)),
			getDomRootId(source!.session),
			createVisualCapturePlan(source!.session, source!.pageSession, {}),
		])
		for (const result of results) {
			expect(result.status).toBe('rejected')
			if (result.status === 'rejected') expect(result.reason.code).toBe('extension_frame_not_ready')
		}
		expect(harness.commands.filter((command) => methods.includes(command.method as CdpMethod))).toHaveLength(0)
		expect(harness.commands.some((command) => command.method === 'DOM.getFrameOwner')).toBe(false)

		// Reload remains deliberately tab-scoped even with a pending iframe selection.
		await source!.pageSession!.sendAndWait('Page.reload')
		expect(harness.commands.at(-1)).toMatchObject({ method: 'Page.reload', sessionId: undefined })
		await source!.attachTarget!('tab:1')
		await source!.session.sendAndWait('Runtime.evaluate', { expression: 'location.href' })
		expect(harness.commands.at(-1)).toMatchObject({ method: 'Runtime.evaluate', params: { expression: 'location.href' }, sessionId: undefined })
		expect(source!.session.getTargetContext?.()).toEqual({ kind: 'page' })
	})

	it('waits for a rematched iframe execution context and resumes in that frame', async () => {
		const harness = await createHarness()
		await source!.attachTarget!('frame:1:old')
		harness.detach()
		const evaluation = source!.session.sendAndWait('Runtime.evaluate', { expression: 'location.href' })
		harness.restore('new', 23)
		await evaluation
		expect(harness.commands.find((command) => command.params?.expression === 'location.href')).toMatchObject({
			method: 'Runtime.evaluate',
			params: { contextId: 23 },
			sessionId: undefined,
		})
		expect(await source!.listTargets!()).toMatchObject([
			{ id: 'tab:1', attached: false },
			{ id: 'frame:1:new', attached: true, targetReady: true },
		])
	})

	it('routes a recovered cross-origin iframe command to its child CDP session', async () => {
		const harness = await createHarness()
		await source!.attachTarget!('frame:1:old')
		harness.detach()
		const evaluation = source!.session.sendAndWait('Runtime.evaluate', { expression: 'location.href' })
		harness.restore('new', 24, 'child-session')
		await evaluation
		expect(harness.commands.find((command) => command.params?.expression === 'location.href')).toMatchObject({ sessionId: 'child-session' })
	})

	it('resolves DOM and capture metadata from the recovered frame rather than its stale id', async () => {
		const harness = await createHarness()
		await source!.attachTarget!('frame:1:old')
		harness.detach()
		const dom = getDomRootId(source!.session)
		const capture = createVisualCapturePlan(source!.session, source!.pageSession, {})
		harness.restore('new', 26)
		expect(await dom).toBe(42)
		expect((await capture).clip).toMatchObject({ x: 10, y: 20, width: 200, height: 100 })
		expect(harness.commands.find((command) => command.params?.expression === 'document')).toMatchObject({ params: { contextId: 26 } })
		expect(harness.commands.find((command) => command.method === 'DOM.getFrameOwner')).toMatchObject({ params: { frameId: 'new' } })
	})

	it('guards an early requested frame even before its URL hint exists', async () => {
		const harness = await createHarness()
		await source!.attachTarget!('frame:1:not-discovered')
		expect(source!.session.getTargetContext?.()).toMatchObject({ kind: 'frame', frameId: 'not-discovered' })
		const evaluation = source!.session.sendAndWait('Runtime.evaluate', { expression: 'location.href' })
		harness.restore('not-discovered', 25)
		await evaluation
		expect(harness.commands.find((command) => command.params?.expression === 'location.href')).toMatchObject({ params: { contextId: 25 } })
	})
})

async function createHarness() {
	let receive: (message: ExtensionToTabHost) => void = () => {}
	const commands: Array<Extract<TabHostToExtension, { type: 'cdp_command' }>> = []
	const statuses: CdpSourceStatus[] = []
	const rootFrame = { id: 'root', url: 'https://host.test/app' }
	let childFrames = [{ frame: { id: 'old', parentId: 'root', url: 'https://game.test/embed?token=old' } }]
	let attached: () => void = () => {}
	const bootstrapped = new Promise<void>((resolve) => {
		attached = resolve
	})

	const messaging: nativeMessaging.NativeMessagingHandler<ExtensionToTabHost, TabHostToExtension> = {
		onMessage: (callback) => {
			receive = callback
		},
		onDisconnect: () => {},
		start: () => {},
		stop: () => {},
		send: (message) => {
			if (message.type !== 'cdp_command') return
			commands.push(message)
			const result = message.method === 'Page.getFrameTree' ? { frameTree: { frame: rootFrame, childFrames } } : commandResult(message.method)
			receive({ type: 'cdp_response', requestId: message.requestId, result })
		},
	}
	// `createNativeMessaging` is generic over the message pair; the spy's return type erases to unknown.
	messagingSpy = spyOn(nativeMessaging, 'createNativeMessaging').mockReturnValue(messaging as never)
	source = createExtensionSource({
		sourcemaps: createSourcemapResolver(),
		events: {
			onLog: () => {},
			onStatus: (status) => {
				statuses.push(status)
			},
			onAttach: () => {
				attached()
			},
		},
	})
	receive({
		type: 'tab_attached',
		tabId: 1,
		url: rootFrame.url,
		title: 'Host',
		topFrameId: 'root',
		frames: [
			{ frameId: 'root', parentFrameId: null, url: rootFrame.url, title: 'Host', sessionId: null },
			{ frameId: 'old', parentFrameId: 'root', url: childFrames[0].frame.url, title: 'Game', sessionId: null },
		],
	})
	await bootstrapped
	const emit = (method: string, params: unknown, sessionId?: string) => receive({ type: 'cdp_event', tabId: 1, method, params, sessionId })
	emit('Runtime.executionContextCreated', { context: { id: 12, auxData: { frameId: 'old', isDefault: true } } })
	// Drain the title refresh before each test begins tracking command dispatch.
	await Promise.resolve()
	commands.length = 0
	return {
		commands,
		statuses,
		emit,
		detach: () => {
			childFrames = []
			emit('Page.frameDetached', { frameId: 'old' })
		},
		restore: (frameId: string, contextId: number, sessionId?: string) => {
			const frame = { id: frameId, parentId: 'root', url: 'https://game.test/embed?token=new' }
			childFrames = [{ frame }]
			emit('Page.frameNavigated', { frame }, sessionId)
			emit('Runtime.executionContextCreated', { context: { id: contextId, auxData: { frameId, isDefault: true } } }, sessionId)
		},
	}
}

function commandResult(method: string): unknown {
	switch (method) {
		case 'DOM.requestNode':
			return { nodeId: 42 }
		case 'DOM.getFrameOwner':
			return { backendNodeId: 42 }
		case 'DOM.getBoxModel':
			return { model: { content: [10, 20, 210, 20, 210, 120, 10, 120] } }
		case 'Page.getLayoutMetrics':
			return { visualViewport: { pageX: 0, pageY: 0, scale: 1, clientWidth: 1280, clientHeight: 720 } }
		default:
			return { result: { value: 'Game', objectId: 'document-object' } }
	}
}
