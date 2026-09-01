import { describe, expect, it } from 'bun:test'
import type { DialogStatus } from '@vforsh/argus-core'
import { diagnoseCdpHealth, isCdpTimeoutError, toDiagnosedError, type CdpHealthProbe } from '../src/cdp/health.js'

const healthyProbe: CdpHealthProbe = {
	watcherId: 'app',
	isAttached: () => true,
	probeRenderer: async () => true,
	checkTransport: async () => ({ state: 'ok' }),
}

describe('diagnoseCdpHealth', () => {
	it('blames the expression only when every other layer answers', async () => {
		const diagnosis = await diagnoseCdpHealth(healthyProbe)

		expect(diagnosis.code).toBe('cdp_timeout')
		expect(diagnosis.message).toContain('longer timeout')
	})

	it('reports a detached watcher before probing anything', async () => {
		const diagnosis = await diagnoseCdpHealth({
			...healthyProbe,
			isAttached: () => false,
			checkTransport: async () => {
				throw new Error('must not run')
			},
		})

		expect(diagnosis.code).toBe('cdp_not_attached')
		expect(diagnosis.message).toContain('argus watcher status app')
	})

	it('reports an unreachable browser endpoint', async () => {
		const diagnosis = await diagnoseCdpHealth({
			...healthyProbe,
			checkTransport: async () => ({ state: 'unreachable', detail: '127.0.0.1:9222: fetch failed' }),
		})

		expect(diagnosis.code).toBe('chrome_unreachable')
		expect(diagnosis.message).toContain('127.0.0.1:9222')
	})

	it('starts reattachment when the target was replaced', async () => {
		let reattached = 0
		const diagnosis = await diagnoseCdpHealth({
			...healthyProbe,
			checkTransport: async () => ({ state: 'target_gone', detail: 'Chrome no longer lists target T1' }),
			onTargetGone: () => {
				reattached += 1
			},
		})

		expect(diagnosis.code).toBe('cdp_target_replaced')
		expect(reattached).toBe(1)
		expect(diagnosis.message).toContain('retry the command')
	})

	it('reports a blocking dialog instead of calling the renderer wedged', async () => {
		const dialog: DialogStatus = {
			type: 'confirm',
			message: 'Leave?',
			defaultPrompt: null,
			url: null,
			hasBrowserHandler: false,
			openedAt: 0,
		}

		const diagnosis = await diagnoseCdpHealth({
			...healthyProbe,
			getBlockingDialog: () => dialog,
			probeRenderer: async () => false,
		})

		expect(diagnosis.code).toBe('dialog_blocking')
		expect(diagnosis.message).toContain('argus dialog accept app')
	})

	it('reports an unresponsive renderer and says a longer timeout will not help', async () => {
		const diagnosis = await diagnoseCdpHealth({ ...healthyProbe, probeRenderer: async () => false })

		expect(diagnosis.code).toBe('cdp_renderer_unresponsive')
		expect(diagnosis.message).toContain('longer timeout will not help')
		expect(diagnosis.message).toContain('argus reload app')
	})

	it('skips transport layers a source cannot answer', async () => {
		const diagnosis = await diagnoseCdpHealth({ isAttached: () => true, probeRenderer: async () => false })

		expect(diagnosis.code).toBe('cdp_renderer_unresponsive')
		expect(diagnosis.message).toContain('argus reload <id>')
	})
})

describe('isCdpTimeoutError', () => {
	it('matches the timeouts both transports raise', () => {
		expect(isCdpTimeoutError(new Error('CDP request timed out after 20000ms'))).toBe(true)
		expect(isCdpTimeoutError(new Error('Bridge request timed out after 60000ms'))).toBe(true)
	})

	it('ignores unrelated failures', () => {
		expect(isCdpTimeoutError(new Error('No element found for selector: #missing'))).toBe(false)
		expect(isCdpTimeoutError('CDP request timed out after 1ms')).toBe(false)
	})
})

describe('toDiagnosedError', () => {
	it('keeps the original message and appends the layered explanation', async () => {
		const error = toDiagnosedError(await diagnoseCdpHealth(healthyProbe), new Error('CDP request timed out after 10000ms'))

		expect(error.code).toBe('cdp_timeout')
		expect(error.message).toStartWith('CDP request timed out after 10000ms.')
	})
})
