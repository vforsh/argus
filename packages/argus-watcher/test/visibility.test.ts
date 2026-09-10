import { expect, test } from 'bun:test'
import type { CdpSessionHandle } from '../src/cdp/connection.js'
import { createVisibilityController } from '../src/visibility/VisibilityController.js'

function session(calls: Array<{ method: string; params: unknown }>): CdpSessionHandle {
	return {
		isAttached: () => true,
		sendAndWait: async (method: string, params: unknown) => {
			calls.push({ method, params })
			return {}
		},
	} as CdpSessionHandle
}

test('background lock survives detached reads and reattachment without bringing the page forward', async () => {
	const calls: Array<{ method: string; params: unknown }> = []
	const target = session(calls)
	const controller = createVisibilityController()
	expect(controller.getDesired()).toBe('default')
	expect(controller.getPolicy()).toBe('foreground')
	await controller.setLock(null, 'shown', 'background')
	expect(controller.getDesired()).toBe('shown')
	expect(controller.getPolicy()).toBe('background')
	expect(calls).toEqual([])
	await controller.onAttach(target)
	await controller.onAttach(target)
	await controller.setLock(target, 'default')
	expect(controller.getPolicy()).toBe('background')
	expect(calls).toEqual([
		{ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
		{ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
		{ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
	])
	// Restoring an unlocked foreground policy is also non-activating.
	await controller.setLock(target, 'default', 'foreground')
	expect(calls.at(-1)).toEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } })
})

test('explicit foreground show retains tab activation', async () => {
	const calls: Array<{ method: string; params: unknown }> = []
	const controller = createVisibilityController()
	await controller.setLock(session(calls), 'shown', 'foreground')
	expect(calls.map((call) => call.method)).toEqual(['Page.bringToFront', 'Emulation.setFocusEmulationEnabled'])
})

test('restoring a shown foreground snapshot can suppress activation for cleanup', async () => {
	const calls: Array<{ method: string; params: unknown }> = []
	const controller = createVisibilityController()
	const target = session(calls)
	await controller.setLock(target, 'shown', 'foreground', false)
	expect(controller.getDesired()).toBe('shown')
	expect(controller.getPolicy()).toBe('foreground')
	expect(calls.map((call) => call.method)).toEqual(['Emulation.setFocusEmulationEnabled'])
	await controller.onAttach(target)
	expect(calls.map((call) => call.method)).toEqual([
		'Emulation.setFocusEmulationEnabled',
		'Page.bringToFront',
		'Emulation.setFocusEmulationEnabled',
	])
})
