import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import type { AuthCookiesResponse } from '@vforsh/argus-core'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

const TEST_HTML = `
<!DOCTYPE html>
<html>
<head>
	<title>auth-e2e</title>
</head>
<body>
	Auth test fixture
</body>
</html>
`

describe('auth e2e', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let watcherProc: ChildProcess
	let watcherId: string
	let httpServer: http.Server
	let httpPort: number

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-auth-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const debugPort = await getFreePort()
		httpPort = await getFreePort()
		watcherId = `auth-e2e-${Date.now()}`

		httpServer = http.createServer((_req, res) => {
			res.writeHead(200, {
				'Content-Type': 'text/html',
				'Set-Cookie': [
					'starkuser=session-cookie-secret; Path=/; HttpOnly; SameSite=Lax',
					'csrftoken=csrf-cookie-secret; Path=/; SameSite=Lax',
					'_ga=tracking-cookie-secret; Path=/; SameSite=Lax',
				],
			})
			res.end(TEST_HTML)
		})
		await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve))

		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		const page = await context.newPage()
		await page.goto(`http://127.0.0.1:${httpPort}/`)

		const watcherConfig = {
			id: watcherId,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { title: 'auth-e2e' },
			host: '127.0.0.1',
			port: 0,
		}

		const { proc, stdout } = await spawnAndWait('bun', [FIXTURE_WATCHER, JSON.stringify(watcherConfig)], { env }, /\{"id":"auth-e2e-/)
		watcherProc = proc

		const watcherInfo = JSON.parse(stdout)

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
		watcherProc?.kill('SIGTERM')
		await browser?.close()
		await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	test('auth cookies lists cookies without exposing raw values by default', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'auth', 'cookies', watcherId], { env })

		expect(stdout).toContain('starkuser')
		expect(stdout).toContain('csrftoken')
		expect(stdout).not.toContain('session-cookie-secret')
	})

	test('auth cookies --json --show-values returns raw cookie values', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'auth', 'cookies', watcherId, '--json', '--show-values'], { env })
		const response = JSON.parse(stdout) as AuthCookiesResponse
		const sessionCookie = response.cookies.find((cookie) => cookie.name === 'starkuser')

		expect(response.ok).toBe(true)
		expect(sessionCookie?.value).toBe('session-cookie-secret')
	})

	test('auth export-cookies emits Netscape format', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-cookies', watcherId, '--format', 'netscape'], { env })

		expect(stdout).toContain('# Netscape HTTP Cookie File')
		expect(stdout).toContain('#HttpOnly_127.0.0.1')
		expect(stdout).toContain('starkuser\tsession-cookie-secret')
	})

	test('auth cookies --exclude-tracking hides analytics cookies', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'auth', 'cookies', watcherId, '--exclude-tracking'], { env })

		expect(stdout).toContain('starkuser')
		expect(stdout).not.toContain('_ga')
	})
})
