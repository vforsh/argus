import { describe, expect, test } from 'bun:test'
import { runBoundedTraversal } from '../src/boundedTraversal.js'
import { acquireLeaseRecord, releaseLeaseRecord, renewLeaseRecord } from '../src/leaseModel.js'

describe('lease and bounded traversal', () => {
	test('rejects overlap, renews owner, and recovers after stale TTL/reload', () => {
		const first = acquireLeaseRecord(null, { token: 'a', operation: 'apply', now: 0, ttlMs: 100 })
		if (first instanceof Error) throw first
		expect(acquireLeaseRecord(first, { token: 'b', operation: 'query', now: 50, ttlMs: 100 })).toBeInstanceOf(Error)
		expect(renewLeaseRecord(first, 'a', 50, 100)).toMatchObject({ token: 'a', expiresAt: 150 })
		expect(releaseLeaseRecord(first, 'b')).toBeInstanceOf(Error)
		expect(acquireLeaseRecord(first, { token: 'b', operation: 'query', now: 101, ttlMs: 100 })).toMatchObject({ token: 'b' })
		expect(renewLeaseRecord(null, 'a', 10, 100)).toBeInstanceOf(Error)
	})

	test('bounds a simulated 595-tab traversal, restores once, and does no post-timeout switching', async () => {
		const tabs = Array.from({ length: 595 }, (_, index) => index)
		let now = 0
		let activations = 0
		let restorations = 0
		const result = await runBoundedTraversal({
			items: tabs,
			deadlineAt: 10,
			now: () => now,
			step: async (tab) => {
				activations++
				now += 2
				return tab
			},
			restore: async () => {
				restorations++
			},
		})
		expect(result).toMatchObject({ completed: false, processed: 5, reason: 'deadline' })
		expect(restorations).toBe(1)
		const atReturn = activations
		await Bun.sleep(10)
		expect(activations).toBe(atReturn)
	})
})
