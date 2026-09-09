import { NATIVE_MESSAGING_PROTOCOL_VERSION } from '../src/types/messages.js'
import { expect, it } from 'bun:test'
import type { ControlHostToExtension, ExtensionToControlHost, ExtensionToTabHost, HostToExtension } from '../src/types/messages.js'

/** One mock port stands in for both native hosts, so it speaks both directions of both protocols. */
type AnyHostToExtension = HostToExtension | ControlHostToExtension
type AnyExtensionToHost = ExtensionToTabHost | ExtensionToControlHost
import type { PopupActionMessage, PopupResponse } from '../src/background/popup-protocol.js'
import { CONTROL_HOST_NAME } from '../src/background/native-hosts.js'

it('propagates Chrome attachment failures through popup/control, cleans only failed sessions, and allows retry', async () => {
	const originalChrome = globalThis.chrome
	const harness = installChromeMock()
	const { bridgeSessions, debuggerManager } = await import('../src/background/service-worker.js')
	try {
		// Popup and CLI requests for one tab must share a single initialized native host.
		const simultaneous = await Promise.all([
			harness.popup({ action: 'attach', tabId: 4 }),
			harness.control({ type: 'attach_tab_watcher', requestId: 4, tabId: 4 }),
		])
		expect(simultaneous[0]).toEqual({ success: true })
		expect(simultaneous[1]).toMatchObject({ ok: true })
		expect(harness.ports.filter((port) => port.sent.some((message) => message.type === 'init_tab_watcher'))).toHaveLength(1)
		expect(harness.ports.flatMap((port) => port.sent).filter((message) => message.type === 'init_tab_watcher')).toHaveLength(1)

		expect(await harness.control({ type: 'set_tab_muted', requestId: 5, tabId: 4, muted: true })).toMatchObject({
			type: 'tab_mute_response',
			requestId: 5,
			ok: true,
			muted: true,
			tab: { tabId: 4, attached: true },
		})
		expect(harness.tabMuteUpdates).toEqual([{ tabId: 4, muted: true }])
		await harness.popup({ action: 'detach', tabId: 4 })

		// A native host that exits during debugger initialization must leave no orphan.
		harness.disconnectDuringSetup.add(4)
		expect(await harness.popup({ action: 'attach', tabId: 4 })).toMatchObject({ success: false })
		expect(debuggerManager.isAttached(4)).toBe(false)
		expect(bridgeSessions.has(4)).toBe(false)
		harness.disconnectDuringSetup.delete(4)
		expect(await harness.popup({ action: 'attach', tabId: 4 })).toEqual({ success: true })
		await harness.popup({ action: 'detach', tabId: 4 })

		// An unrelated working session must survive both failure paths.
		expect(await harness.popup({ action: 'attach', tabId: 3 })).toEqual({ success: true })
		const unrelated = bridgeSessions.get(3)!

		for (const entry of [
			{ tabId: 1, via: 'popup' },
			{ tabId: 2, via: 'control' },
		] as const) {
			const { tabId, via } = entry
			const error = `Another debugger is already attached to the tab with id: ${tabId}.`
			harness.conflicts.add(tabId)
			if (via === 'popup') {
				expect(await harness.popup({ action: 'attach', tabId })).toEqual({ success: false, error })
			} else {
				expect(await harness.control({ type: 'attach_tab_watcher', requestId: 1, tabId, watcherId: 'requested' })).toEqual({
					type: 'tab_action_response',
					requestId: 1,
					ok: false,
					error: { message: error },
				})
			}

			const failedPort = harness.ports.at(-1)!
			expect(failedPort.disconnected).toBe(true)
			expect(failedPort.sent).toContainEqual({ type: 'tab_detached', tabId, reason: error })
			expect(failedPort.sent.some((message) => message.type === 'tab_attached')).toBe(false)
			expect(bridgeSessions.has(tabId)).toBe(false)
			expect(debuggerManager.isAttached(tabId)).toBe(false)
			expect(bridgeSessions.get(3)).toBe(unrelated)
			expect(unrelated.isConnected()).toBe(true)
			expect(debuggerManager.isAttached(3)).toBe(true)

			const status = await harness.popup({ action: 'getStatus' })
			if (!status.success || !('status' in status)) throw new Error('Missing popup status')
			expect(status.status.attachedTabs.map((tab) => tab.tabId)).toEqual([3])

			// Recorded events reach consumers through control diagnostics, not the popup payload.
			const diagnostics = await harness.control({ type: 'control_status', requestId: 99 })
			if (diagnostics.type !== 'control_status_response') throw new Error('Missing control diagnostics')
			expect(
				diagnostics.diagnostics.recentEvents.some(
					(event) => event.level === 'info' && event.message.toLowerCase().includes(`attached tab ${tabId}`),
				),
			).toBe(false)

			harness.conflicts.delete(tabId)
			if (via === 'popup') {
				expect(await harness.popup({ action: 'attach', tabId })).toEqual({ success: true })
			} else {
				expect(await harness.control({ type: 'attach_tab_watcher', requestId: 2, tabId, watcherId: 'requested' })).toMatchObject({
					ok: true,
					watcherId: 'requested',
					tab: { tabId, attached: true },
				})
			}
			expect(debuggerManager.isAttached(tabId)).toBe(true)
			expect(bridgeSessions.get(tabId)?.isConnected()).toBe(true)
			expect(harness.ports.at(-1)?.sent.some((message) => message.type === 'tab_attached' && message.tabId === tabId)).toBe(true)
			expect(await harness.popup({ action: 'detach', tabId })).toEqual({ success: true })
		}
	} finally {
		for (const tabId of [...bridgeSessions.keys()]) await harness.popup({ action: 'detach', tabId })
		globalThis.chrome = originalChrome
	}
})

function installChromeMock() {
	const conflicts = new Set<number>()
	const disconnectDuringSetup = new Set<number>()
	const ports: ReturnType<typeof createPort>[] = []
	const tabMuteUpdates: Array<{ tabId: number; muted: boolean }> = []
	let onPopup: (message: PopupActionMessage, sender: unknown, respond: (response: PopupResponse) => void) => void = () => {}
	const tab = (id: number) => ({ id, url: `https://example.test/${id}`, title: `Tab ${id}`, windowId: 1 })
	const chromeMock = {
		runtime: {
			id: 'test-extension',
			getManifest: () => ({ version: '1.0' }),
			onMessage: {
				addListener: (handler: typeof onPopup) => {
					onPopup = handler
				},
			},
			onStartup: { addListener: () => {} },
			onInstalled: { addListener: () => {} },
			connectNative: (name: string) => {
				const port = createPort(name)
				ports.push(port)
				return port
			},
		},
		debugger: {
			onEvent: { addListener: () => {} },
			onDetach: { addListener: () => {} },
			attach: async ({ tabId }: { tabId: number }) => {
				if (conflicts.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`)
			},
			detach: async () => {},
			sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
				if (conflicts.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`)
				if (method === 'Target.setAutoAttach' && disconnectDuringSetup.has(tabId)) ports.at(-1)!.drop()
				return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: `root-${tabId}`, url: tab(tabId).url } } } : {}
			},
		},
		tabs: {
			get: async (id: number) => tab(id),
			query: async () => [tab(1), tab(2), tab(3), tab(4)],
			update: async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
				if (properties.muted !== undefined) tabMuteUpdates.push({ tabId, muted: properties.muted })
				return tab(tabId)
			},
		},
		action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
		storage: { local: { get: (_key: string, callback: (data: unknown) => void) => callback({}) } },
	}
	globalThis.chrome = chromeMock as unknown as typeof chrome
	return {
		conflicts,
		disconnectDuringSetup,
		ports,
		tabMuteUpdates,
		popup: (message: PopupActionMessage) =>
			new Promise<PopupResponse>((resolve) => {
				onPopup(message, {}, resolve)
			}),
		control: (message: ControlHostToExtension) => ports.find((port) => port.name === CONTROL_HOST_NAME)!.request(message),
	}
}

function createPort(name: string) {
	let receive: (message: AnyHostToExtension) => void = () => {}
	let onDisconnect = () => {}
	let response: ((message: AnyExtensionToHost) => void) | undefined
	const port = {
		name,
		disconnected: false,
		sent: [] as AnyExtensionToHost[],
		onMessage: {
			addListener: (handler: typeof receive) => {
				receive = handler
			},
		},
		onDisconnect: {
			addListener: (handler: () => void) => {
				onDisconnect = handler
			},
		},
		drop: () => {
			port.disconnected = true
			onDisconnect()
		},
		disconnect: () => {
			port.disconnected = true
		},
		postMessage: (message: AnyExtensionToHost) => {
			port.sent.push(message)
			if (message.type === 'init_tab_watcher') {
				receive({ type: 'host_ready' })
				receive({
					type: 'host_info',
					watcherId: message.watcherId ?? 'test-watcher',
					watcherHost: '127.0.0.1',
					watcherPort: 1234,
					pid: 123,
					protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
				})
			}
			if (message.type === 'tab_action_response' || message.type === 'tab_mute_response' || message.type === 'control_status_response')
				response?.(message)
		},
		request: (message: AnyHostToExtension) =>
			new Promise<AnyExtensionToHost>((resolve) => {
				response = resolve
				receive(message)
			}),
	}
	return port
}
