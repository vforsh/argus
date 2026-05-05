import { describe, expect, it } from 'bun:test'

import { isLowInterestTarget } from '../src/popup/classify-target.js'

const iframeTarget = (url: string, title = url) => ({
	type: 'iframe' as const,
	title,
	url,
})

describe('classify-target', () => {
	it.each([
		['Google cookie rotation', 'https://accounts.google.com/RotateCookiesPage?og_pid=283&origin=https%3A%2F%2Fdocs.google.com'],
		['Google API proxy', 'https://clients6.google.com/static/proxy.html?usegapi=1'],
		['Google contacts hovercard', 'https://contacts.google.com/u/2/widget/hovercard/v/2?origin=https%3A%2F%2Fdocs.google.com'],
		['Google app backplane', 'https://docs.google.com/_/og/bscframe'],
		['Google Docs offline API', 'https://docs.google.com/offline/iframeapi?ouid=u838cba5946cf14b3&sa=6'],
	])('treats %s iframes as low-interest Google plumbing', (_name, url) => {
		expect(isLowInterestTarget(iframeTarget(url))).toBe(true)
	})

	it('treats InMobi sync iframes as low-interest ad plumbing', () => {
		expect(isLowInterestTarget(iframeTarget('https://sync.inmobi.com/setuid?bidderID=&dspUserId=', 'https://sync.inmobi.com/setuid'))).toBe(true)
	})

	it('keeps game iframes visible', () => {
		expect(isLowInterestTarget(iframeTarget('https://localhost:8009/?ctl=1&showFps=0', 'Cocos Creator - arrows'))).toBe(false)
	})

	it('keeps ordinary Google Docs iframes visible', () => {
		expect(isLowInterestTarget(iframeTarget('https://docs.google.com/document/d/example/edit', 'Embedded document'))).toBe(false)
	})
})
