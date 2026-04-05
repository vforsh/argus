import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait, stopProcess } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

describe('network workflow e2e', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let watcherProc: ChildProcess
	let watcherId: string
	let appServer: http.Server
	let analyticsServer: http.Server
	let appPort: number
	let analyticsPort: number

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-net-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const debugPort = await getFreePort()
		appPort = await getFreePort()
		analyticsPort = await getFreePort()
		watcherId = `net-e2e-${Date.now()}`

		appServer = http.createServer((req, res) => {
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

			if (url.pathname === '/api/really-delayed') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ reallyDelayed: true }))
				return
			}

			res.writeHead(404)
			res.end('missing')
		})

		analyticsServer = http.createServer((req, res) => {
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

		await new Promise<void>((resolve) => appServer.listen(appPort, '127.0.0.1', resolve))
		await new Promise<void>((resolve) => analyticsServer.listen(analyticsPort, '127.0.0.1', resolve))

		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		const page = await context.newPage()
		await page.goto(`http://127.0.0.1:${appPort}/`)
		await page.waitForTimeout(900)

		const watcherConfig = {
			id: watcherId,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { title: 'net-e2e' },
			host: '127.0.0.1',
			port: 0,
			net: { enabled: true },
		}

		const { proc, stdout } = await spawnAndWait('bun', [FIXTURE_WATCHER, JSON.stringify(watcherConfig)], { env }, /\{"id":"net-e2e-/)
		watcherProc = proc

		const watcherInfo = JSON.parse(stdout) as { port: number }
		let attached = false
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const res = await fetch(`http://127.0.0.1:${watcherInfo.port}/status`)
				const status = (await res.json()) as { attached: boolean }
				if (status.attached) {
					attached = true
					break
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 200))
		}

		expect(attached).toBe(true)
	})

	afterAll(async () => {
		await stopProcess(watcherProc)
		await browser?.close()
		await new Promise<void>((resolve) => appServer?.close(() => resolve()))
		await new Promise<void>((resolve) => analyticsServer?.close(() => resolve()))
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	test('clear, watch, and summary support the reload workflow', async () => {
		const { stdout: initialNetOut } = await runCommand('node', [BIN_PATH, 'net', watcherId, '--json'], { env })
		const initialRequests = JSON.parse(initialNetOut) as Array<{ url: string }>
		expect(initialRequests.length).toBeGreaterThan(0)

		const { stdout: clearOut } = await runCommand('node', [BIN_PATH, 'net', 'clear', watcherId, '--json'], { env })
		const clearResult = JSON.parse(clearOut) as { cleared: number }
		expect(clearResult.cleared).toBeGreaterThan(0)

		const { stdout: afterClearOut } = await runCommand('node', [BIN_PATH, 'net', watcherId, '--ignore-host', 'localhost', '--json'], { env })
		expect(JSON.parse(afterClearOut)).toEqual([])

		const { stdout: watchOut } = await runCommand(
			'node',
			[BIN_PATH, 'net', 'watch', watcherId, '--reload', '--settle', '400ms', '--ignore-pattern', '/poll', '--json'],
			{ env },
		)
		const watchResult = JSON.parse(watchOut) as {
			cleared: number
			reloaded: boolean
			timedOut: boolean
			requests: Array<{ id: number; requestId: string; url: string; status: number | null; timingPhases?: unknown }>
		}
		expect(watchResult.cleared).toBeGreaterThanOrEqual(0)
		expect(watchResult.reloaded).toBe(true)
		expect(watchResult.timedOut).toBe(false)
		expect(watchResult.requests.some((request) => request.url.includes('/api/fast'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/slow'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/fail'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/big'))).toBe(true)
		expect(watchResult.requests.some((request) => request.url.includes('/api/delayed'))).toBe(true)

		const delayedRequest = watchResult.requests.find((request) => request.url.includes('/api/delayed'))
		expect(delayedRequest).toBeTruthy()

		const { stdout: detailOut } = await runCommand('node', [BIN_PATH, 'net', 'show', String(delayedRequest!.id), watcherId, '--json'], { env })
		const detail = JSON.parse(detailOut) as {
			id: number
			requestId: string
			url: string
			status: number | null
			timingPhases: { totalMs: number | null } | null
		}
		expect(detail.id).toBe(delayedRequest!.id)
		expect(detail.requestId).toBe(delayedRequest!.requestId)
		expect(detail.url.includes('/api/delayed')).toBe(true)
		expect(detail.status).toBe(200)
		expect(detail.timingPhases?.totalMs).not.toBeNull()

		const { stdout: detailByRequestIdOut } = await runCommand('node', [BIN_PATH, 'net', 'show', delayedRequest!.requestId, watcherId, '--json'], {
			env,
		})
		const detailByRequestId = JSON.parse(detailByRequestIdOut) as { id: number; requestId: string }
		expect(detailByRequestId.id).toBe(delayedRequest!.id)
		expect(detailByRequestId.requestId).toBe(delayedRequest!.requestId)

		const { stdout: summaryOut } = await runCommand('node', [BIN_PATH, 'net', 'summary', watcherId, '--json'], { env })
		const summary = JSON.parse(summaryOut) as {
			totalRequests: number
			failedCount: number
			statusCounts: Array<{ status: string; count: number }>
			slowestRequests: Array<{ url: string }>
			largestTransfers: Array<{ url: string }>
			topHosts: Array<{ host: string; count: number }>
			navigation: { type: string } | null
		}

		expect(summary.totalRequests).toBeGreaterThanOrEqual(5)
		expect(summary.failedCount).toBeGreaterThanOrEqual(1)
		expect(summary.statusCounts.some((entry) => entry.status === '200')).toBe(true)
		expect(summary.statusCounts.some((entry) => entry.status === '503')).toBe(true)
		expect(summary.slowestRequests.some((request) => request.url.includes('/api/slow'))).toBe(true)
		expect(summary.largestTransfers.some((request) => request.url.includes('/api/big'))).toBe(true)
		expect(summary.topHosts.length).toBeGreaterThan(0)
		expect(summary.topHosts.some((entry) => entry.count > 0)).toBe(true)
		expect(summary.navigation?.type).toBe('reload')

		const { stdout: filteredSummaryOut } = await runCommand(
			'node',
			[BIN_PATH, 'net', 'summary', watcherId, '--ignore-host', 'localhost', '--json'],
			{ env },
		)
		const filteredSummary = JSON.parse(filteredSummaryOut) as {
			totalRequests: number
			failedCount: number
			slowestRequests: Array<{ url: string }>
			largestTransfers: Array<{ url: string }>
			topHosts: Array<{ host: string; count: number }>
		}

		expect(filteredSummary.totalRequests).toBeLessThan(summary.totalRequests)
		expect(filteredSummary.topHosts.some((entry) => entry.host.includes('localhost'))).toBe(false)
		expect(filteredSummary.slowestRequests.some((request) => request.url.includes('localhost'))).toBe(false)
		expect(filteredSummary.largestTransfers.some((request) => request.url.includes('localhost'))).toBe(false)

		const { stdout: thirdPartyOut } = await runCommand('node', [BIN_PATH, 'net', watcherId, '--third-party', '--json'], { env })
		const thirdPartyRequests = JSON.parse(thirdPartyOut) as Array<{ url: string }>
		expect(thirdPartyRequests.length).toBeGreaterThan(0)
		expect(thirdPartyRequests.every((request) => request.url.includes('localhost'))).toBe(true)

		const { stdout: firstPartyOut } = await runCommand('node', [BIN_PATH, 'net', watcherId, '--first-party', '--json'], { env })
		const firstPartyRequests = JSON.parse(firstPartyOut) as Array<{ url: string }>
		expect(firstPartyRequests.length).toBeGreaterThan(0)
		expect(firstPartyRequests.some((request) => request.url.includes('/api/fast'))).toBe(true)
		expect(firstPartyRequests.some((request) => request.url.includes('localhost'))).toBe(false)

		const { stdout: failedOnlyOut } = await runCommand('node', [BIN_PATH, 'net', watcherId, '--status', '503', '--failed-only', '--json'], {
			env,
		})
		const failedOnlyRequests = JSON.parse(failedOnlyOut) as Array<{ url: string; status: number | null }>
		expect(failedOnlyRequests).toHaveLength(1)
		expect(failedOnlyRequests[0]?.url.includes('/api/fail')).toBe(true)
		expect(failedOnlyRequests[0]?.status).toBe(503)

		const { stdout: slowOut } = await runCommand(
			'node',
			[BIN_PATH, 'net', watcherId, '--resource-type', 'Fetch', '--mime', 'application/json', '--slow-over', '200ms', '--json'],
			{ env },
		)
		const slowRequests = JSON.parse(slowOut) as Array<{ url: string }>
		expect(slowRequests.some((request) => request.url.includes('/api/slow'))).toBe(true)

		const { stdout: largeOut } = await runCommand('node', [BIN_PATH, 'net', watcherId, '--large-over', '60kb', '--json'], { env })
		const largeRequests = JSON.parse(largeOut) as Array<{ url: string }>
		expect(largeRequests).toHaveLength(1)
		expect(largeRequests[0]?.url.includes('/api/big')).toBe(true)

		const { stdout: timedWatchOut } = await runCommand(
			'node',
			[BIN_PATH, 'net', 'watch', watcherId, '--reload', '--settle', '300ms', '--max-timeout', '1200ms', '--json'],
			{ env },
		)
		const timedWatch = JSON.parse(timedWatchOut) as {
			timedOut: boolean
			requests: Array<{ url: string }>
		}
		expect(timedWatch.timedOut).toBe(true)
		expect(timedWatch.requests.length).toBeGreaterThan(0)
	}, 15_000)
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
		const run = () => {
			fetch('/api/fast').catch(() => {})
			fetch('/api/slow').catch(() => {})
			fetch('/api/fail').catch(() => {})
			fetch('/api/big').catch(() => {})
			setTimeout(() => {
				fetch('/api/delayed').catch(() => {})
			}, 500)
			setTimeout(() => {
				fetch('/api/really-delayed').catch(() => {})
			}, 2500)
			fetch(analyticsBase + '/beacon').catch(() => {})
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
