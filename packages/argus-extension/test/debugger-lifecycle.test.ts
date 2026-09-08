import { afterEach, beforeEach, expect, it } from 'bun:test'
import { DebuggerManager } from '../src/background/debugger-manager.js'

const originalChrome = globalThis.chrome
let owner: 'argus' | 'external' | null
let attachCalls: number
let detachCalls: number
let failSetup: boolean
let failTabLookup: boolean
let manager: DebuggerManager

beforeEach(() => {
	owner = null
	attachCalls = detachCalls = 0
	failSetup = failTabLookup = false
	globalThis.chrome = {
		debugger: {
			onEvent: { addListener: () => {} },
			onDetach: { addListener: () => {} },
			attach: async () => {
				attachCalls++
				if (owner) throw new Error('Another debugger is already attached to the tab with id: 1.')
				owner = 'argus'
			},
			detach: async () => {
				detachCalls++
				if (owner !== 'argus') throw new Error('Debugger is not attached to the tab with id: 1.')
				owner = null
			},
			sendCommand: async (_target: unknown, method: string) => {
				if (owner !== 'argus') throw new Error('Debugger is not attached to the tab with id: 1.')
				if (failSetup && method === 'Target.setAutoAttach') throw new Error('Setup failed')
				return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'root', url: 'https://example.test' } } } : {}
			},
		},
		tabs: {
			get: async () => {
				if (failTabLookup) throw new Error('Tab lookup failed')
				return { id: 1, url: 'https://example.test', title: 'Example' }
			},
		},
	} as unknown as typeof chrome
	manager = new DebuggerManager()
})

afterEach(() => {
	globalThis.chrome = originalChrome
})

it('recovers an Argus-owned connection absent from JS state and rebuilds frame state', async () => {
	owner = 'argus'
	expect(manager.isAttached(1)).toBe(false)
	const target = await manager.attach(1)
	expect(target.topFrameId).toBe('root')
	expect(manager.isAttached(1)).toBe(true)
	expect(owner).toBe('argus')
	expect(attachCalls).toBe(2)
	expect(detachCalls).toBe(1)
})

it('preserves the external-owner error without attempting to detach it', async () => {
	owner = 'external'
	await expect(manager.attach(1)).rejects.toThrow('Another debugger is already attached')
	expect(owner).toBe('external')
	expect(detachCalls).toBe(0)
	expect(manager.isAttached(1)).toBe(false)
})

it('serializes concurrent attaches and a following detach', async () => {
	const first = manager.attach(1)
	const second = manager.attach(1)
	const detached = manager.detach(1)
	expect(await first).toBe(await second)
	await detached
	expect(attachCalls).toBe(1)
	expect(detachCalls).toBe(1)
	expect(owner).toBeNull()
	expect(manager.isAttached(1)).toBe(false)
})

it('releases a stale owned attachment even without a tracked target', async () => {
	owner = 'argus'
	await manager.detach(1)
	expect(owner).toBeNull()
	await manager.detach(1)
	owner = 'external'
	await manager.detach(1)
	expect(owner).toBe('external')
})

it.each(['lookup', 'setup'])('rolls back ownership after %s failure and allows retry', async (failure) => {
	failTabLookup = failure === 'lookup'
	failSetup = failure === 'setup'
	await expect(manager.attach(1)).rejects.toThrow(failure === 'lookup' ? 'Tab lookup failed' : 'Setup failed')
	expect(owner).toBeNull()
	expect(manager.isAttached(1)).toBe(false)
	failTabLookup = failSetup = false
	await manager.attach(1)
	expect(manager.isAttached(1)).toBe(true)
})
