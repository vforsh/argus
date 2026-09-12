import { syncActionBadge } from '../src/background/action-badge.js'
import type { DebuggerManager } from '../src/background/debugger-manager.js'
import { expect, test } from 'bun:test'
import { BridgeClient } from '../src/background/bridge-client.js'
import { flushLifecycleJournal, lifecycleSnapshot, recordLifecycle } from '../src/background/lifecycle-journal.js'
import { NATIVE_MESSAGING_PROTOCOL_VERSION } from '../src/types/messages.js'

test('simulated disconnect backs off until handshake, cancels disposal retries, and ignores stale ports', async () => {
	const originalChrome = globalThis.chrome
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	const timers = new Map<number, { callback: () => void; delay: number }>()
	let timerId = 90000
	const ports: Array<{ receive: (message: unknown) => void; drop: () => void }> = []
	const saved: Record<string, unknown> = {}
	let inDisconnect = false
	let lastErrorReads = 0
	globalThis.setTimeout = ((callback: () => void, delay: number) => {
		if (delay < 1000) return originalSetTimeout(callback, delay)
		const id = ++timerId
		timers.set(id, { callback, delay })
		return id
	}) as typeof setTimeout
	globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
		if (!timers.delete(Number(id))) originalClearTimeout(id)
	}) as typeof clearTimeout
	globalThis.chrome = {
		storage: {
			local: {
				get: async () => saved,
				set: async (value: object) => {
					Object.assign(saved, value)
				},
			},
		},
		runtime: {
			get lastError() {
				expect(inDisconnect).toBe(true)
				lastErrorReads++
				return { message: 'Native host has exited' }
			},
			connectNative: () => {
				const handlers = { receive: (_message: unknown) => {}, drop: () => {} }
				ports.push(handlers)
				return {
					onMessage: {
						addListener: (fn: (message: unknown) => void) => {
							handlers.receive = fn
						},
					},
					onDisconnect: {
						addListener: (fn: () => void) => {
							handlers.drop = () => {
								inDisconnect = true
								try {
									fn()
								} finally {
									inDisconnect = false
								}
							}
						},
					},
					postMessage: () => {},
					disconnect: () => {},
				}
			},
		},
	} as unknown as typeof chrome
	const bridge = new BridgeClient()
	try {
		bridge.connect()
		ports[0]!.drop()
		expect([...timers.values()][0]?.delay).toBe(1000)
		const runRetry = () => {
			const [id, timer] = [...timers.entries()][0]!
			timers.delete(id)
			timer.callback()
		}
		runRetry()
		ports[1]!.drop()
		expect([...timers.values()][0]?.delay).toBe(2000)
		runRetry()
		ports[2]!.receive({ type: 'host_info', protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION })
		ports[0]!.drop() // Delayed callback from the old port must not clear the current one.
		expect(bridge.isConnected()).toBe(true)
		ports[2]!.drop()
		expect([...timers.values()][0]?.delay).toBe(1000)
		bridge.disconnect()
		expect(timers.size).toBe(0)
		expect(lastErrorReads).toBe(4)
		const exhausted = new BridgeClient()
		exhausted.connect()
		for (const delay of [1000, 2000, 4000, 8000, 16000]) {
			ports.at(-1)!.drop()
			expect([...timers.values()][0]?.delay).toBe(delay)
			runRetry()
		}
		ports.at(-1)!.drop()
		expect(timers.size).toBe(0)
		exhausted.disconnect()

		await flushLifecycleJournal()
		expect(lifecycleSnapshot().some((event) => event.detail.category === 'Native host has exited')).toBe(true)
		expect(lifecycleSnapshot().some((event) => event.operation === 'bridge.reconnect.exhausted')).toBe(true)
	} finally {
		bridge.disconnect()
		globalThis.setTimeout = originalSetTimeout
		globalThis.clearTimeout = originalClearTimeout
		globalThis.chrome = originalChrome
	}
})

test('simulated API/storage failures remain bounded and retry persistence without exposing error content', async () => {
	const originalChrome = globalThis.chrome
	let fails = true
	let saved: unknown
	globalThis.chrome = {
		tabs: {
			query: async () => {
				throw new Error('No SW token=SECRET')
			},
		},
		storage: {
			local: {
				get: async () => ({}),
				set: async (value: unknown) => {
					if (fails) throw new Error('disk unavailable')
					saved = value
				},
			},
		},
	} as unknown as typeof chrome
	try {
		await syncActionBadge({ listAttached: () => [] } as unknown as DebuggerManager)
		await flushLifecycleJournal()
		expect(lifecycleSnapshot().some((event) => event.operation === 'storage.failed')).toBe(true)
		fails = false
		recordLifecycle('worker.initialized')
		await flushLifecycleJournal()
		expect(JSON.stringify(saved)).toContain('api.syncActionBadge.failed')
		expect(JSON.stringify(saved)).not.toContain('SECRET')
		for (let i = 0; i < 1000; i++) recordLifecycle('bridge.connect.attempt', { attempt: i })
		await flushLifecycleJournal()
		expect(lifecycleSnapshot().length).toBeLessThanOrEqual(128)
	} finally {
		globalThis.chrome = originalChrome
	}
})
