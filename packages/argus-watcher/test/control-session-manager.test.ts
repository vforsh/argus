import { describe, expect, it } from 'bun:test'
import { ControlSessionManager } from '../src/native-messaging/control-session-manager.js'
import type { NativeMessagingHandler } from '../src/native-messaging/messaging.js'
import type { ControlHostToExtension, ExtensionToControlHost } from '../src/native-messaging/types.js'

describe('ControlSessionManager', () => {
	it('matches concurrent tab list responses by request id', async () => {
		const messaging = createFakeMessaging()
		const manager = new ControlSessionManager(messaging)

		const first = manager.listTabs({ url: 'first' })
		const second = manager.listTabs({ title: 'second' })

		expect(messaging.sent).toEqual([
			{ type: 'list_tabs', requestId: 1, filter: { url: 'first' } },
			{ type: 'list_tabs', requestId: 2, filter: { title: 'second' } },
		])

		messaging.emit({ type: 'list_tabs_response', requestId: 2, tabs: [tab(2)] })
		messaging.emit({ type: 'list_tabs_response', requestId: 1, tabs: [tab(1)] })

		expect(await first).toEqual([tab(1)])
		expect(await second).toEqual([tab(2)])
	})

	it('sends stable watcher ids with attach requests and resolves action responses', async () => {
		const messaging = createFakeMessaging()
		const manager = new ControlSessionManager(messaging)

		const attached = manager.attachTabWatcher(10, { watcherId: 'app' })
		expect(messaging.sent[0]).toEqual({ type: 'attach_tab_watcher', requestId: 1, tabId: 10, watcherId: 'app' })

		messaging.emit({ type: 'tab_action_response', requestId: 1, ok: true, tab: tab(10, 'app'), watcherId: 'app' })

		expect(await attached).toEqual({ ok: true, tab: tab(10, 'app'), watcherId: 'app' })
	})

	it('requests live diagnostics through the control bridge', async () => {
		const messaging = createFakeMessaging()
		const manager = new ControlSessionManager(messaging)

		const diagnostics = manager.getDiagnostics()
		expect(messaging.sent[0]).toEqual({ type: 'control_status', requestId: 1 })

		messaging.emit({
			type: 'control_status_response',
			requestId: 1,
			diagnostics: {
				extensionId: 'ext',
				extensionVersion: '1.0.0',
				control: {
					connected: true,
					watcherId: 'extension-control',
					watcherHost: '127.0.0.1',
					watcherPort: 1234,
					pid: 42,
					lastMessageAt: 1000,
				},
				tabWatchers: [],
				recentEvents: [],
			},
		})

		expect(await diagnostics).toMatchObject({ extensionId: 'ext', control: { watcherId: 'extension-control' } })
	})
})

const tab = (tabId: number, watcherId?: string) => ({
	tabId,
	url: `https://example.test/${tabId}`,
	title: `Tab ${tabId}`,
	attached: Boolean(watcherId),
	watcherId,
})

const createFakeMessaging = (): NativeMessagingHandler<ExtensionToControlHost, ControlHostToExtension> & {
	sent: ControlHostToExtension[]
	emit: (message: ExtensionToControlHost) => void
} => {
	let onMessage: ((message: ExtensionToControlHost) => void) | null = null
	return {
		sent: [],
		onMessage: (callback) => {
			onMessage = callback
		},
		onDisconnect: () => {},
		send(message) {
			this.sent.push(message)
		},
		start: () => {},
		stop: () => {},
		emit(message) {
			onMessage?.(message)
		},
	}
}
