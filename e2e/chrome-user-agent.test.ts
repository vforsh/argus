import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait, stopProcess } from './helpers/process.js'
import { waitForWatcherAttached } from './helpers/watcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const LITERAL_USER_AGENT = 'Argus Literal Browser/14.0 exact'

describe('Chrome startup user agent e2e', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let origin: string
	let closeSite: () => Promise<void>
	const requestUserAgents = new Map<string, string>()
	const processes: ChildProcess[] = []

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-ua-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const port = await getFreePort()
		const server = http.createServer((request, response) => {
			const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
			if (!requestUserAgents.has(pathname)) {
				requestUserAgents.set(pathname, request.headers['user-agent'] ?? '')
			}
			response.writeHead(200, { 'Content-Type': 'text/html' })
			response.end(`<!doctype html><title>${pathname}</title>`)
		})
		await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${port}`
		closeSite = () => new Promise<void>((resolve) => server.close(() => resolve()))
	})

	afterAll(async () => {
		await Promise.all(processes.map((process) => stopProcess(process)))
		await closeSite?.()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	test('chrome start sends an exact literal UA on the first request', async () => {
		const url = `${origin}/literal`
		const watcherId = `ua-literal-e2e-${Date.now()}`
		const { proc, stdout } = await spawnAndWait(
			'node',
			[BIN_PATH, 'chrome', 'start', '--url', url, '--headless', '--profile', 'temp', '--user-agent', LITERAL_USER_AGENT, '--json'],
			{ env },
			/\{"chromePid":/,
		)
		processes.push(proc)
		const info = JSON.parse(stdout.trim()) as { cdpHost: string; cdpPort: number; userAgentOverride: boolean }
		const { proc: watcherProc } = await spawnAndWait(
			'node',
			[
				BIN_PATH,
				'watcher',
				'start',
				'--id',
				watcherId,
				'--url',
				url,
				'--chrome-host',
				info.cdpHost,
				'--chrome-port',
				String(info.cdpPort),
				'--json',
			],
			{ env },
			new RegExp(`\\{"id":"${watcherId}"`),
		)
		processes.push(watcherProc)
		await waitForWatcherAttached(BIN_PATH, watcherId, { env })
		const { stdout: evalStdout } = await runCommand('node', [BIN_PATH, 'eval', watcherId, 'navigator.userAgent', '--json'], { env })

		expect((JSON.parse(evalStdout) as { result: string }).result).toBe(LITERAL_USER_AGENT)
		expect(requestUserAgents.get('/literal')).toBe(LITERAL_USER_AGENT)
		expect(info.userAgentOverride).toBe(true)
	}, 15_000)

	test('combined start uses regular Chrome UA for the first request and page runtime', async () => {
		const url = `${origin}/regular`
		const watcherId = `ua-e2e-${Date.now()}`
		const { proc, stdout } = await spawnAndWait(
			'node',
			[BIN_PATH, 'start', '--id', watcherId, '--url', url, '--headless', '--profile', 'temp', '--user-agent', 'regular-chrome', '--json'],
			{ env },
			new RegExp(`\\{"id":"${watcherId}"`),
		)
		processes.push(proc)
		await waitForWatcherAttached(BIN_PATH, watcherId, { env })
		const info = JSON.parse(stdout.trim()) as { userAgentOverride: boolean }
		const { stdout: evalStdout } = await runCommand('node', [BIN_PATH, 'eval', watcherId, 'navigator.userAgent', '--json'], { env })
		const runtimeUserAgent = (JSON.parse(evalStdout) as { result: string }).result

		expect(runtimeUserAgent).toContain('Chrome/')
		expect(runtimeUserAgent).not.toContain('HeadlessChrome/')
		expect(requestUserAgents.get('/regular')).toBe(runtimeUserAgent)
		expect(info.userAgentOverride).toBe(true)
	}, 15_000)
})
