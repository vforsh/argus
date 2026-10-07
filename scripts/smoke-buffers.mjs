import assert from 'node:assert/strict'
import { LogBuffer } from '../packages/argus-watcher/dist/buffer/LogBuffer.js'
import { NetBuffer } from '../packages/argus-watcher/dist/buffer/NetBuffer.js'

const event = { ts: 1, level: 'log', text: 'retained', args: [], file: null, line: null, column: null, pageUrl: null, pageTitle: null, source: 'console' }
const net = (requestId) => ({ summary: { requestId, ts: 1, method: 'GET', url: 'https://example.com', status: 200 }, detail: { requestId }, bodySessionId: 'child-session' })
for (const capacity of [-1, 0, 1, 3, 50_000]) {
	const logs = new LogBuffer(capacity)
	const network = new NetBuffer(capacity)
	const count = Math.max(0, capacity)
	for (let id = 1; id <= count + 20; id++) {
		logs.add(event)
		network.add(net('reused'))
		const expected = Math.min(id, count)
		assert.equal(logs.getStats().count, expected)
		assert.equal(network.getStats().count, expected)
		if (!expected) { assert.equal(network.getRecordByRequestId('reused'), null); continue }
		assert.equal(network.getRecordByRequestId('reused').detail.id, id)
		assert.equal(network.getRecordById(id).bodySessionId, 'child-session')
		assert.equal(network.getRecordById(id - count), null)
	}
	const stats = logs.getStats()
	const ids = logs.listAfter(0, {}, Infinity).map((value) => value.id)
	assert.deepEqual(ids, count ? Array.from({ length: count }, (_, i) => stats.minId + i) : [])
	for (const after of [0, 10, stats.maxId ?? 0, (stats.maxId ?? 0) - 3, Infinity, NaN]) {
		for (const limit of [0, 1, 2, -1, 1.5, Infinity, NaN]) {
			const expected = ids.filter((id) => id > after).slice(0, limit)
			assert.deepEqual(logs.listAfter(after, {}, limit).map((value) => value.id), expected)
			assert.deepEqual(network.listAfter(after, {}, limit).map((value) => value.id), expected)
		}
	}
	network.clear()
	assert.equal(network.getRecordByRequestId('reused'), null)
	const next = network.add(net('next'))
	assert.equal(next.id, count + 21)
	if (count) {
		network.add(net('other'))
		assert.equal(network.getRecordByRequestId('reused'), null)
	}
}
const logs = new LogBuffer(3)
const cursor = logs.beginLogEpoch()
const waiting = logs.waitForAfterEpoch(cursor, { levels: ['error'] }, 1, 1000)
logs.add(event)
logs.add({ ...event, level: 'error' })
assert.deepEqual((await waiting).events.map((value) => value.id), [2])
const nextCursor = logs.beginLogEpoch()
assert.equal((await logs.waitForAfterEpoch(nextCursor, {}, 1, 1)).nextCursor, nextCursor)
console.log('Buffer smoke passed: wraparound, cursor/limit equivalence, latest request id, child ownership, clear, long polling')
