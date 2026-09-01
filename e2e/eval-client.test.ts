import { describe, expect, test } from 'bun:test'
import { HttpResponseError } from '@vforsh/argus-core'
import { formatEvalTransportError } from '@vforsh/argus/internal'

const watcher = { id: 'extension' }

describe('eval client errors', () => {
	test('names watcher health before suggesting a longer eval timeout', () => {
		const message = formatEvalTransportError(watcher, new Error('Request timed out after 10000ms'), undefined)

		expect(message).toContain('extension: failed to reach watcher (Request timed out after 10000ms)')
		expect(message).toContain('argus watcher status extension')
		expect(message).toContain('pass a longer timeout as milliseconds or a duration')
		expect(message).toContain('argus eval extension --timeout 60s ...')
	})

	test('suggests increasing an explicitly configured timeout', () => {
		const message = formatEvalTransportError(watcher, new Error('Bridge request timed out after 60000ms'), 60_000)

		expect(message).toContain('argus eval extension --timeout 120s ...')
	})

	test('leaves the watcher\u2019s own diagnosis alone', () => {
		// The watcher answered: its reply already names the layer that stalled, so the CLI must not
		// bolt "the watcher did not answer" onto it.
		const rejection = new HttpResponseError(
			'CDP request timed out after 10000ms. The page\u2019s renderer did not answer a trivial evaluation within 2000ms',
			500,
		)

		const message = formatEvalTransportError(watcher, rejection, undefined)

		expect(message).toStartWith('extension: watcher rejected the request (')
		expect(message).not.toContain('pass a longer timeout')
	})

	test('keeps non-timeout transport errors concise', () => {
		const message = formatEvalTransportError(watcher, new Error('ECONNREFUSED'), undefined)

		expect(message).toBe('extension: failed to reach watcher (ECONNREFUSED)')
	})
})
