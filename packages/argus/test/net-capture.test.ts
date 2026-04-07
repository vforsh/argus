import { describe, expect, it } from 'bun:test'
import { parseNetCaptureOptions } from '../src/commands/netCapture.js'

const parse = (options: Parameters<typeof parseNetCaptureOptions>[0]) => parseNetCaptureOptions(options, { defaultClear: true })

describe('parseNetCaptureOptions', () => {
	it('rejects reload with selected-frame scope', () => {
		expect(parse({ reload: true, scope: 'selected' }).error).toContain('Cannot combine --reload')
		expect(parse({ reload: true, frame: 'selected' }).error).toContain('Cannot combine --reload')
	})

	it('allows reload with page or tab scope', () => {
		expect(parse({ reload: true, scope: 'page' }).error).toBeUndefined()
		expect(parse({ reload: true }).error).toBeUndefined()
	})

	it('parses settle-after with a default polling interval', () => {
		const parsed = parse({ settleAfter: 'window.appReady' })
		expect(parsed.error).toBeUndefined()
		expect(parsed.value?.settleAfter).toEqual({
			expression: 'window.appReady',
			intervalMs: 250,
		})
	})

	it('rejects settle-after interval without an expression', () => {
		expect(parse({ settleAfterInterval: '100ms' }).error).toContain('--settle-after')
	})
})
