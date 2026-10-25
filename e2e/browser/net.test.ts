import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import type { Cli } from '../helpers/cli.js'
import { startSite, type Site } from '../helpers/site.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

describe('network workflow e2e', () => {
	let fx: CdpFixture
	let cli: Cli
	let watcherId: string
	let app: Site
	let analytics: Site
	let appPort: number
	let analyticsPort: number

	beforeAll(async () => {
		watcherId = `net-e2e-${Date.now()}`

		// Analytics first: the app page embeds its port.
		analytics = await startSite((req, res) => {
			const url = new URL(req.url ?? '/', `http://localhost:${analyticsPort}`)
			res.setHeader('Access-Control-Allow-Origin', '*')
			if (url.pathname === '/beacon') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ beacon: true }))
				return
			}

			if (url.pathname === '/poll') {
				setTimeout(() => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify({ poll: true }))
				}, 150)
				return
			}

			res.writeHead(404)
			res.end('missing')
		})
		analyticsPort = analytics.port

		app = await startSite((req, res) => {
			const url = new URL(req.url ?? '/', `http://127.0.0.1:${appPort}`)
			if (url.pathname === '/') {
				res.writeHead(200, { 'Content-Type': 'text/html' })
				res.end(renderAppHtml(analyticsPort))
				return
			}

			if (url.pathname === '/api/fast') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ ok: true }))
				return
			}

			if (url.pathname === '/api/slow') {
				setTimeout(() => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify({ slow: true }))
				}, 250)
				return
			}

			if (url.pathname === '/api/post') {
				const chunks: Buffer[] = []
				req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(
						JSON.stringify({
							ok: true,
							received: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
						}),
					)
				})
				return
			}

			if (url.pathname === '/api/fail') {
				res.writeHead(503, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ ok: false }))
				return
			}

			if (url.pathname === '/api/big') {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('x'.repeat(64 * 1024))
				return
			}

			if (url.pathname === '/api/delayed') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ delayed: true }))
				return
			}

			if (url.pathname === '/api/late-match') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ lateMatch: true }))
				return
			}

			if (url.pathname === '/api/really-delayed') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ reallyDelayed: true }))
				return
			}

			res.writeHead(404)
			res.end('missing')
		})
		appPort = app.port

		fx = await startCdpFixture({
			prefix: 'argus-net-e2e',
			runtime: 'node',
			watcher: { id: watcherId, match: { title: 'net-e2e' }, net: { enabled: true } },
			preparePage: async (page) => {
				await page.goto(`http://127.0.0.1:${appPort}/`)
				await page.waitForTimeout(900)
			},
		})
		cli = fx.cli
	})

	afterAll(async () => {
		await fx?.close()
		await app?.close()
		await analytics?.close()
	})

	/** Block until the page reports every one-shot request has settled. */
	const waitForPageNetIdle = async (): Promise<void> => {
		await cli.run(['eval-until', watcherId, 'window.__netIdle === true', '--total-timeout', '15s', '--json'])
	}

	/**
	 * Block until the watcher stops receiving new non-analytics requests.
	 *
	 * The page being done issuing does not mean the CDP events have all reached the
	 * watcher, so wait for two consecutive reads to agree. The `/poll` interval never
	 * stops, hence the same --ignore-host filter the assertion uses.
	 */
	const waitForNetBufferQuiescence = async (): Promise<void> => {
		let previous = -1
		for (let attempt = 0; attempt < 40; attempt++) {
			const { stdout } = await cli.run(['net', watcherId, '--ignore-host', 'localhost', '--json'])
			const count = (JSON.parse(stdout) as unknown[]).length
			if (count === previous) {
				return
			}
			previous = count
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
		throw new Error('Network buffer never settled')
	}

	// Runs ~25s (a 15s __netIdle wait plus two reload workflows); the 25s it used to carry left no
	// headroom and timed out under load, so it relies on the browser tier's 60s budget.
	test('clear, watch, and summary support the reload workflow', async () => {
		const initialRequests = await cli.json<Array<{ url: string }>>(['net', watcherId, '--json'])
		expect(initialRequests.length).toBeGreaterThan(0)

		// The page issues its last one-shot request 2500ms after load. Clearing before that
		// lands leaves it in the buffer, which is what made the emptiness assertion below
		// flaky. Wait for the page to finish issuing, then for the watcher to finish
		// receiving, before clearing.
		await waitForPageNetIdle()
		await waitForNetBufferQuiescence()

		const clearResult = await cli.json<{ cleared: number }>(['net', 'clear', watcherId, '--json'])
		expect(clearResult.cleared).toBeGreaterThan(0)

		const { stdout: afterClearOut } = await cli.run(['net', watcherId, '--ignore-host', 'localhost', '--json'])
		expect(JSON.parse(afterClearOut)).toEqual([])

		const watchResult = await cli.json<{
			cleared: number
			reloaded: boolean
			timedOut: boolean
			requests: Array<{ id: number; requestId: string; url: string; status: number | null; timingPhases?: unknown }>
		}>(['net', 'watch', watcherId, '--reload', '--settle', '400ms', '--ignore-pattern', '/poll', '--json'])
		expect(watchResult.cleared).toBeGreaterThanOrEqual(0)
		expect(watchResult.reloaded).toBe(true)
		expect(watchResult.timedOut).toBe(false)
		expect(watchResult.requests.some((request) => request.url.includes('/api/fast'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/post'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/slow'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/fail'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/big'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/delayed'))).toBe(true)

		const delayedRequest = watchResult.requests.find((request) => request.url.includes('/api/delayed'))
		expect(delayedRequest).toBeTruthy()

		const detail = await cli.json<{
			id: number
			requestId: string
			url: string
			status: number | null
			timingPhases: { totalMs: number | null } | null
		}>(['net', 'show', String(delayedRequest!.id), watcherId, '--json'])
		expect(detail.id).toBe(delayedRequest!.id)
		expect(detail.requestId).toBe(delayedRequest!.requestId)
		expect(detail.url.includes('/api/delayed')).toBe(true)
		expect(detail.status).toBe(200)
		expect(detail.timingPhases?.totalMs).not.toBeNull()

		const detailByRequestId = await cli.json<{ id: number; requestId: string }>(['net', 'show', delayedRequest!.requestId, watcherId, '--json'])
		expect(detailByRequestId.id).toBe(delayedRequest!.id)
		expect(detailByRequestId.requestId).toBe(delayedRequest!.requestId)

		const postRequest = watchResult.requests.find((request) => request.url.includes('/api/post'))
		expect(postRequest).toBeTruthy()

		const postDetail = await cli.json<{
			id: number
			body: { request: boolean; response: boolean }
		}>(['net', 'show', String(postRequest!.id), watcherId, '--json'])
		expect(postDetail.id).toBe(postRequest!.id)
		expect(postDetail.body).toEqual({ request: true, response: true })

		const responseBody = await cli.json<{
			part: 'response'
			base64Encoded: boolean
			body: string
		}>(['net', 'body', String(postRequest!.id), watcherId, '--json'])
		expect(responseBody.part).toBe('response')
		expect(responseBody.base64Encoded).toBe(false)
		expect(JSON.parse(responseBody.body)).toEqual({
			ok: true,
			received: { source: 'argus-net-e2e', count: 1 },
		})

		const requestBody = await cli.json<{
			part: 'request'
			base64Encoded: boolean
			body: string
		}>(['net', 'body', String(postRequest!.id), watcherId, '--request', '--json'])
		expect(requestBody.part).toBe('request')
		expect(requestBody.base64Encoded).toBe(false)
		expect(JSON.parse(requestBody.body)).toEqual({
			source: 'argus-net-e2e',
			count: 1,
		})

		const inspectResult = await cli.json<{
			ok: true
			pattern: string
			reloaded: boolean
			timedOut: boolean
			matchedCount: number
			request: { url: string; method: string; body: { request: boolean; response: boolean } }
			requestBody: { part: 'request'; body: string } | null
			responseBody: { part: 'response'; body: string } | null
		}>(['net', 'inspect', '/api/post', watcherId, '--reload', '--settle', '400ms', '--ignore-pattern', '/poll', '--json'])
		expect(inspectResult.ok).toBe(true)
		expect(inspectResult.pattern).toBe('/api/post')
		expect(inspectResult.reloaded).toBe(true)
		expect(inspectResult.timedOut).toBe(false)
		expect(inspectResult.matchedCount).toBeGreaterThan(0)
		expect(inspectResult.request.url.includes('/api/post')).toBe(true)
		expect(inspectResult.request.method).toBe('POST')
		expect(inspectResult.request.body).toEqual({ request: true, response: true })
		expect(inspectResult.requestBody?.part).toBe('request')
		expect(JSON.parse(inspectResult.requestBody?.body ?? 'null')).toEqual({
			source: 'argus-net-e2e',
			count: 1,
		})
		expect(inspectResult.responseBody?.part).toBe('response')
		expect(JSON.parse(inspectResult.responseBody?.body ?? 'null')).toEqual({
			ok: true,
			received: { source: 'argus-net-e2e', count: 1 },
		})

		const lateInspect = await cli.json<{
			ok: true
			pattern: string
			request: { url: string; method: string }
			responseBody: { part: 'response'; body: string } | null
		}>(['net', 'inspect', '/api/late-match', watcherId, '--reload', '--settle', '400ms', '--ignore-pattern', '/poll', '--response', '--json'])
		expect(lateInspect.ok).toBe(true)
		expect(lateInspect.pattern).toBe('/api/late-match')
		expect(lateInspect.request.url.includes('/api/late-match')).toBe(true)
		expect(lateInspect.request.method).toBe('GET')
		expect(JSON.parse(lateInspect.responseBody?.body ?? 'null')).toEqual({ lateMatch: true })

		const harPath = path.join(fx.home, 'boot.har')
		const exportResult = await cli.json<{
			ok: true
			format: string
			out: string
			requestCount: number
			reloaded: boolean
			timedOut: boolean
		}>(['net', 'export', watcherId, '--reload', '--settle', '400ms', '--ignore-pattern', '/poll', '--out', harPath, '--json'])
		expect(exportResult.format).toBe('har')
		expect(exportResult.out).toBe(harPath)
		expect(exportResult.reloaded).toBe(true)
		expect(exportResult.timedOut).toBe(false)
		expect(exportResult.requestCount).toBeGreaterThan(0)

		const exportedHar = JSON.parse(await fs.readFile(harPath, 'utf8')) as {
			log: {
				version: string
				creator: { name: string }
				entries: Array<{ request: { url: string } }>
			}
		}
		expect(exportedHar.log.version).toBe('1.2')
		expect(exportedHar.log.creator.name).toBe('Argus')
		expect(exportedHar.log.entries.some((entry) => entry.request.url.includes('/api/fast'))).toBe(true)
		expect(exportedHar.log.entries.some((entry) => entry.request.url.includes('/api/slow'))).toBe(true)
		expect(exportedHar.log.entries.some((entry) => entry.request.url.includes('/api/delayed'))).toBe(true)

		const summary = await cli.json<{
			totalRequests: number
			failedCount: number
			statusCounts: Array<{ status: string; count: number }>
			slowestRequests: Array<{ url: string }>
			largestTransfers: Array<{ url: string }>
			topHosts: Array<{ host: string; count: number }>
			navigation: { type: string } | null
		}>(['net', 'summary', watcherId, '--json'])

		expect(summary.totalRequests).toBeGreaterThanOrEqual(5)
		expect(summary.failedCount).toBeGreaterThanOrEqual(1)
		expect(summary.statusCounts.some((entry) => entry.status === '200')).toBe(true)
		expect(summary.statusCounts.some((entry) => entry.status === '503')).toBe(true)
		expect(summary.slowestRequests.some((request) => request.url.includes('/api/slow'))).toBe(true)
		expect(summary.largestTransfers.some((request) => request.url.includes('/api/big'))).toBe(true)
		expect(summary.topHosts.length).toBeGreaterThan(0)
		expect(summary.topHosts.some((entry) => entry.count > 0)).toBe(true)
		expect(summary.navigation?.type).toBe('reload')

		const filteredSummary = await cli.json<{
			totalRequests: number
			failedCount: number
			slowestRequests: Array<{ url: string }>
			largestTransfers: Array<{ url: string }>
			topHosts: Array<{ host: string; count: number }>
		}>(['net', 'summary', watcherId, '--ignore-host', 'localhost', '--json'])

		expect(filteredSummary.totalRequests).toBeLessThan(summary.totalRequests)
		expect(filteredSummary.topHosts.some((entry) => entry.host.includes('localhost'))).toBe(false)
		expect(filteredSummary.slowestRequests.some((request) => request.url.includes('localhost'))).toBe(false)
		expect(filteredSummary.largestTransfers.some((request) => request.url.includes('localhost'))).toBe(false)

		const thirdPartyRequests = await cli.json<Array<{ url: string }>>(['net', watcherId, '--third-party', '--json'])
		expect(thirdPartyRequests.length).toBeGreaterThan(0)
		expect(thirdPartyRequests.every((request) => request.url.includes('localhost'))).toBe(true)

		const firstPartyRequests = await cli.json<Array<{ url: string }>>(['net', watcherId, '--first-party', '--json'])
		expect(firstPartyRequests.length).toBeGreaterThan(0)
		expect(firstPartyRequests.some((request) => request.url.includes('/api/fast'))).toBe(true)
		expect(firstPartyRequests.some((request) => request.url.includes('localhost'))).toBe(false)

		const failedOnlyRequests = await cli.json<Array<{ url: string; status: number | null }>>([
			'net',
			watcherId,
			'--status',
			'503',
			'--failed-only',
			'--json',
		])
		expect(failedOnlyRequests).toHaveLength(1)
		expect(failedOnlyRequests[0]?.url.includes('/api/fail')).toBe(true)
		expect(failedOnlyRequests[0]?.status).toBe(503)

		const slowRequests = await cli.json<Array<{ url: string }>>([
			'net',
			watcherId,
			'--resource-type',
			'Fetch',
			'--mime',
			'application/json',
			'--slow-over',
			'200ms',
			'--json',
		])
		expect(slowRequests.some((request) => request.url.includes('/api/slow'))).toBe(true)

		const largeRequests = await cli.json<Array<{ url: string }>>(['net', watcherId, '--large-over', '60kb', '--json'])
		expect(largeRequests).toHaveLength(1)
		expect(largeRequests[0]?.url.includes('/api/big')).toBe(true)

		const timedWatch = await cli.json<{
			timedOut: boolean
			requests: Array<{ url: string }>
		}>(['net', 'watch', watcherId, '--reload', '--settle', '300ms', '--max-timeout', '1200ms', '--json'])
		expect(timedWatch.timedOut).toBe(true)
		expect(timedWatch.requests.length).toBeGreaterThan(0)

		const gatedWatch = await cli.json<{
			timedOut: boolean
			requests: Array<{ url: string }>
		}>([
			'net',
			'watch',
			watcherId,
			'--reload',
			'--settle-after',
			'window.__netReady === true',
			'--settle-after-interval',
			'100ms',
			'--settle',
			'400ms',
			'--ignore-pattern',
			'/poll',
			'--json',
		])
		expect(gatedWatch.timedOut).toBe(false)
		expect(gatedWatch.requests.some((request) => request.url.includes('/api/really-delayed'))).toBe(true)

		const gatedInspect = await cli.json<{
			ok: true
			request: { url: string }
			responseBody: { part: 'response'; body: string } | null
		}>([
			'net',
			'inspect',
			'/api/really-delayed',
			watcherId,
			'--reload',
			'--settle-after',
			'window.__netReady === true',
			'--settle-after-interval',
			'100ms',
			'--settle',
			'400ms',
			'--ignore-pattern',
			'/poll',
			'--response',
			'--json',
		])
		expect(gatedInspect.ok).toBe(true)
		expect(gatedInspect.request.url.includes('/api/really-delayed')).toBe(true)
		expect(JSON.parse(gatedInspect.responseBody?.body ?? 'null')).toEqual({ reallyDelayed: true })
	})
})

const renderAppHtml = (analyticsPort: number): string => `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8" />
	<title>net-e2e</title>
</head>
<body>
	<script>
		const analyticsBase = 'http://localhost:${analyticsPort}'
		// Gate for the --settle-after tests. Deliberately set *before* /api/really-delayed
		// fires, so those tests prove gated waiting picks up traffic a naive settle misses.
		window.__netReady = false
		// Set once every one-shot request has settled, so tests that need "the page is done
		// issuing" have a signal that is not racing the 2500ms timer. The /poll interval is
		// excluded on purpose: it never stops.
		window.__netIdle = false
		const run = () => {
			const oneShots = []
			const track = (promise) => {
				oneShots.push(promise.catch(() => {}))
				return promise
			}

			track(fetch('/api/fast')).catch(() => {})
			track(
				fetch('/api/post', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ source: 'argus-net-e2e', count: 1 }),
				}),
			).catch(() => {})
			track(fetch('/api/slow')).catch(() => {})
			track(fetch('/api/fail')).catch(() => {})
			track(fetch('/api/big')).catch(() => {})
			track(fetch(analyticsBase + '/beacon')).catch(() => {})

			let pendingTimers = 3
			const afterTimer = () => {
				pendingTimers -= 1
				if (pendingTimers === 0) {
					Promise.all(oneShots).then(() => {
						window.__netIdle = true
					})
				}
			}

			setTimeout(() => {
				track(fetch('/api/delayed')).catch(() => {})
				afterTimer()
			}, 500)
			setTimeout(() => {
				track(fetch('/api/late-match')).catch(() => {})
				afterTimer()
			}, 1200)
			setTimeout(() => {
				track(fetch('/api/really-delayed')).catch(() => {})
				afterTimer()
			}, 2500)
			setTimeout(() => {
				window.__netReady = true
			}, 2200)
			if (!window.__netPollStarted) {
				window.__netPollStarted = true
				setInterval(() => {
					fetch(analyticsBase + '/poll?ts=' + Date.now()).catch(() => {})
				}, 200)
			}
		}
		window.addEventListener('load', run, { once: true })
	</script>
</body>
</html>
`
