import { expect, test } from 'bun:test'
import { createPendingRequestTable } from '../src/native-messaging/pendingRequests.js'

test('simulated missing native response reports request identity, deadline, elapsed time and last confirmed phase', async () => {
	const table = createPendingRequestTable<number>({ timeoutMs: 20, timeoutMessage: 'Control request timed out' })
	let error: unknown
	try {
		await table.open(17)
	} catch (caught) {
		error = caught
	}
	expect(error).toBeInstanceOf(Error)
	expect((error as Error).message).toMatch(/native request 17; deadline \d+; elapsed \d+ms; response not received/)
	// A late reply cannot accidentally settle the following request.
	table.settle(17, 99)
	const following = table.open(18)
	table.settle(18, 42)
	expect(await following).toBe(42)
})
