import { describe, expect, it } from 'bun:test'
import { LogBuffer, LogEpochError } from '../src/buffer/LogBuffer.js'

const makeEvent = (text: string, level: 'log' | 'warning' | 'error' = 'log') => ({
	ts: Date.now(),
	level,
	text,
	args: [],
	file: null,
	line: null,
	column: null,
	pageUrl: null,
	pageTitle: null,
	source: 'console' as const,
})

describe('log epochs', () => {
	it('returns duplicate messages independently after a marker', () => {
		const buffer = new LogBuffer(10)
		const epoch = buffer.beginLogEpoch()

		buffer.add(makeEvent('same message', 'error'))
		buffer.add(makeEvent('same message', 'error'))

		const result = buffer.listAfterEpoch(epoch, { levels: ['error'] }, 10)
		expect(result.events.map((event) => event.text)).toEqual(['same message', 'same message'])
		expect(result.events[0]?.id).not.toBe(result.events[1]?.id)
	})

	it('keeps a marker valid across page-style reloads and returns an empty delta when unchanged', () => {
		const buffer = new LogBuffer(10)
		buffer.add(makeEvent('before reload'))
		const epoch = buffer.beginLogEpoch()

		expect(buffer.listAfterEpoch(epoch, {}, 10).events).toEqual([])
		buffer.add(makeEvent('after reload', 'warning'))

		const result = buffer.listAfterEpoch(epoch, { levels: ['warning'] }, 10)
		expect(result.events.map((event) => event.text)).toEqual(['after reload'])
	})

	it('reports entries after a marker for error, warning, and unfiltered queries', () => {
		const buffer = new LogBuffer(10)
		const epoch = buffer.beginLogEpoch()
		buffer.add(makeEvent('error after marker', 'error'))
		buffer.add(makeEvent('warning after marker', 'warning'))
		buffer.add(makeEvent('info after marker'))

		expect(buffer.listAfterEpoch(epoch, { levels: ['error'] }, 10).events.map((event) => event.text)).toEqual(['error after marker'])
		expect(buffer.listAfterEpoch(epoch, { levels: ['warning'] }, 10).events.map((event) => event.text)).toEqual(['warning after marker'])
		expect(buffer.listAfterEpoch(epoch, {}, 10).events.map((event) => event.text)).toEqual([
			'error after marker',
			'warning after marker',
			'info after marker',
		])
	})

	it('rejects an epoch once the ring buffer evicts the unread range', () => {
		const buffer = new LogBuffer(2)
		const epoch = buffer.beginLogEpoch()
		buffer.add(makeEvent('one'))
		buffer.add(makeEvent('two'))
		buffer.add(makeEvent('three'))

		try {
			buffer.listAfterEpoch(epoch, {}, 10)
			throw new Error('expected stale epoch')
		} catch (error) {
			expect(error).toBeInstanceOf(LogEpochError)
			expect(error).toMatchObject({ code: 'evicted' })
		}
	})

	it('rejects an epoch from another watcher or a restarted watcher', () => {
		const original = new LogBuffer(10)
		const epoch = original.beginLogEpoch()
		const differentWatcher = new LogBuffer(10)

		for (const buffer of [differentWatcher, new LogBuffer(10)]) {
			expect(() => buffer.listAfterEpoch(epoch, {}, 10)).toThrow('different watcher session')
		}
	})
})
