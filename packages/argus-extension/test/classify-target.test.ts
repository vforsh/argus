import { describe, expect, it } from 'bun:test'

import { isLowInterestTarget } from '../src/popup/classify-target.js'

describe('classify-target', () => {
	it('treats InMobi sync iframes as low-interest ad plumbing', () => {
		expect(
			isLowInterestTarget({
				type: 'iframe',
				title: 'https://sync.inmobi.com/setuid',
				url: 'https://sync.inmobi.com/setuid?bidderID=&dspUserId=',
			}),
		).toBe(true)
	})

	it('keeps game iframes visible', () => {
		expect(
			isLowInterestTarget({
				type: 'iframe',
				title: 'Cocos Creator - arrows',
				url: 'https://localhost:8009/?ctl=1&showFps=0',
			}),
		).toBe(false)
	})
})
