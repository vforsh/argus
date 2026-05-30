import { describe, expect, test } from 'bun:test'
import { formatEvalTransportError } from '../packages/argus/src/eval/evalClient.js'

const watcher = { id: 'extension' }

describe('eval client errors', () => {
	test('suggests a longer eval timeout for request timeouts', () => {
		const message = formatEvalTransportError(watcher, new Error('Request timed out after 10000ms'), undefined)

		expect(message).toContain('extension: failed to reach watcher (Request timed out after 10000ms)')
		expect(message).toContain('pass a longer timeout as milliseconds or a duration')
		expect(message).toContain('argus eval extension --timeout 60s ...')
	})

	test('suggests increasing an explicitly configured timeout', () => {
		const message = formatEvalTransportError(watcher, new Error('Bridge request timed out after 60000ms'), 60_000)

		expect(message).toContain('argus eval extension --timeout 120s ...')
	})

	test('keeps non-timeout transport errors concise', () => {
		const message = formatEvalTransportError(watcher, new Error('ECONNREFUSED'), undefined)

		expect(message).toBe('extension: failed to reach watcher (ECONNREFUSED)')
	})
})
