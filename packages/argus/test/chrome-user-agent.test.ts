import { describe, expect, it } from 'bun:test'
import { resolveChromeUserAgent, toRegularChromeUserAgent } from '../src/commands/chrome/userAgent.js'

describe('Chrome startup user agent', () => {
	it('removes only the headless product marker', () => {
		const headless =
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36'

		expect(toRegularChromeUserAgent(headless)).toBe(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
		)
	})

	it('passes literal values without trimming or rewriting', async () => {
		const literal = ' Literal Browser/1.0 '
		expect(await resolveChromeUserAgent('/unused/chrome', literal)).toBe(literal)
	})
})
