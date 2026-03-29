import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import type { AuthCookiesResponse, AuthStateSnapshot } from '@vforsh/argus-core'
import { getFreePort } from './helpers/ports.js'
import { runCommand, runCommandWithExit, spawnAndWait, stopProcess } from './helpers/process.js'

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
	let fixtureUrl: string
	let blankUrl: string

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-auth-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const debugPort = await getFreePort()
		httpPort = await getFreePort()
		watcherId = `auth-e2e-${Date.now()}`
		fixtureUrl = `http://app.localhost:${httpPort}/`
		blankUrl = `http://app.localhost:${httpPort}/blank`

		httpServer = http.createServer((req, res) => {
			if (req.url === '/blank') {
				res.writeHead(200, {
					'Content-Type': 'text/html',
				})
				res.end(TEST_HTML)
				return
			}
			if (req.url === '/auth-seed') {
				res.writeHead(200, {
					'Content-Type': 'text/html',
					'Set-Cookie': ['sharedAuth=sibling-auth-secret; Path=/; HttpOnly; SameSite=Lax'],
				})
				res.end(TEST_HTML)
				return
			}

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
		await page.goto(`http://auth.localhost:${httpPort}/auth-seed`)
		await page.goto(fixtureUrl)
		await page.evaluate(() => {
			localStorage.setItem('accessToken', 'storage-access-secret')
			sessionStorage.setItem('csrfToken', 'session-csrf-secret')
		})

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
		await stopProcess(watcherProc)
		await browser?.close()
		await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const startFreshWatchedSession = async (url: string, watcherIdPrefix: string) => {
		const { proc: chromeProc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'chrome', 'start', '--url', url, '--headless', '--json'],
			{ env },
			/\{"chromePid":/,
		)
		const info = JSON.parse(stdout.trim()) as { cdpHost: string; cdpPort: number }
		const freshWatcherId = `${watcherIdPrefix}-${Date.now()}`
		const { proc: freshWatcherProc } = await spawnAndWait(
			'bun',
			[
				BIN_PATH,
				'watcher',
				'start',
				'--id',
				freshWatcherId,
				'--url',
				url,
				'--chrome-host',
				info.cdpHost,
				'--chrome-port',
				String(info.cdpPort),
				'--json',
			],
			{ env },
			new RegExp(`\\{"id":"${freshWatcherId}"`),
		)

		return {
			chromeProc,
			watcherProc: freshWatcherProc,
			watcherId: freshWatcherId,
		}
	}

	const expectHydratedFixtureState = (snapshot: AuthStateSnapshot) => {
		expect(snapshot.url).toBe(fixtureUrl)
		expect(snapshot.cookies.some((cookie) => cookie.name === 'starkuser' && cookie.value === 'session-cookie-secret')).toBe(true)
		expect(snapshot.cookies.some((cookie) => cookie.name === 'sharedAuth' && cookie.value === 'sibling-auth-secret')).toBe(true)
		expect(snapshot.origins[0]?.localStorage).toContainEqual({ name: 'accessToken', value: 'storage-access-secret' })
		expect(snapshot.origins[0]?.sessionStorage).toContainEqual({ name: 'csrfToken', value: 'session-csrf-secret' })
	}

	const expectSnapshotMetadata = (snapshot: AuthStateSnapshot, expectedWatcherId: string) => {
		const { metadata } = snapshot
		expect(metadata.schemaVersion).toBe(1)
		expect(metadata.source.watcherId).toBe(expectedWatcherId)
		expect(metadata.source.watcherSource).toBe('cdp')
		expect(metadata.page.title).toBe('auth-e2e')
		expect(metadata.page.siteDomain).toBe('localhost')
		expect(metadata.capture.cookieCount).toBe(snapshot.cookies.length)
		expect(metadata.authHints.authCookieNames).toContain('csrftoken')
		expect(metadata.authHints.authCookieNames).toContain('sharedAuth')
		expect(metadata.recommendedStartupUrl).toBe(fixtureUrl)
		expect(() => new Date(metadata.exportedAt).toISOString()).not.toThrow()
	}

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
		expect(stdout).toContain('#HttpOnly_app.localhost')
		expect(stdout).toContain('starkuser\tsession-cookie-secret')
	})

	test('auth cookies --exclude-tracking hides analytics cookies', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'auth', 'cookies', watcherId, '--exclude-tracking'], { env })

		expect(stdout).toContain('starkuser')
		expect(stdout).not.toContain('_ga')
	})

	test('auth export-state includes cookies and storage for the active page', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', watcherId], { env })
		const snapshot = JSON.parse(stdout) as AuthStateSnapshot

		expect(snapshot.ok).toBe(true)
		expect(snapshot.url).toBe(fixtureUrl)
		expect(snapshot.cookies.some((cookie) => cookie.name === 'starkuser' && cookie.value === 'session-cookie-secret')).toBe(true)
		expect(snapshot.cookies.some((cookie) => cookie.name === 'sharedAuth' && cookie.value === 'sibling-auth-secret')).toBe(true)
		expect(snapshot.origins).toHaveLength(1)
		expect(snapshot.origins[0]?.origin).toBe(fixtureUrl.slice(0, -1))
		expect(snapshot.origins[0]?.localStorage).toContainEqual({ name: 'accessToken', value: 'storage-access-secret' })
		expect(snapshot.origins[0]?.sessionStorage).toContainEqual({ name: 'csrfToken', value: 'session-csrf-secret' })
		expectSnapshotMetadata(snapshot, watcherId)
	})

	test('chrome start --auth-state hydrates a fresh browser session', async () => {
		const authStatePath = path.join(tempDir, 'auth-state.json')
		await runCommand('bun', [BIN_PATH, 'auth', 'export-state', watcherId, '--out', authStatePath], { env })

		const { proc: chromeProc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'chrome', 'start', '--auth-state', authStatePath, '--headless', '--json'],
			{ env },
			/\{"chromePid":/,
		)

		try {
			const info = JSON.parse(stdout.trim()) as { cdpHost: string; cdpPort: number }
			const hydratedWatcherId = `hydrated-auth-${Date.now()}`
			const { proc: watcherProc } = await spawnAndWait(
				'bun',
				[
					BIN_PATH,
					'watcher',
					'start',
					'--id',
					hydratedWatcherId,
					'--url',
					fixtureUrl,
					'--chrome-host',
					info.cdpHost,
					'--chrome-port',
					String(info.cdpPort),
					'--json',
				],
				{ env },
				new RegExp(`\\{"id":"${hydratedWatcherId}"`),
			)

			try {
				const { stdout: hydratedStateStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', hydratedWatcherId], { env })
				const hydratedState = JSON.parse(hydratedStateStdout) as AuthStateSnapshot

				expectHydratedFixtureState(hydratedState)
				expect(hydratedState.cookies.some((cookie) => cookie.name === 'csrftoken' && cookie.value === 'csrf-cookie-secret')).toBe(true)
				expectSnapshotMetadata(hydratedState, hydratedWatcherId)
			} finally {
				await stopProcess(watcherProc)
			}
		} finally {
			await stopProcess(chromeProc)
		}
	}, 20_000)

	test('auth load-state hydrates an already running watcher tab', async () => {
		const authStatePath = path.join(tempDir, 'live-auth-state.json')
		await runCommand('bun', [BIN_PATH, 'auth', 'export-state', watcherId, '--out', authStatePath], { env })

		const { chromeProc, watcherProc, watcherId: hydratedWatcherId } = await startFreshWatchedSession(blankUrl, 'live-auth')
		try {
			const { stdout: loadStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'load-state', hydratedWatcherId, '--in', authStatePath], {
				env,
			})
			expect(loadStdout).toContain(`loaded auth state into ${hydratedWatcherId}`)

			const { stdout: hydratedStateStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', hydratedWatcherId], { env })
			const hydratedState = JSON.parse(hydratedStateStdout) as AuthStateSnapshot

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, hydratedWatcherId)
		} finally {
			await stopProcess(watcherProc)
			await stopProcess(chromeProc)
		}
	}, 20_000)

	test('auth load-state accepts snapshots from stdin', async () => {
		const { stdout: exportedState } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', watcherId], { env })
		const { chromeProc, watcherProc, watcherId: hydratedWatcherId } = await startFreshWatchedSession(blankUrl, 'stdin-auth')

		try {
			const { stdout: loadStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'load-state', hydratedWatcherId, '--in', '-'], {
				env,
				input: exportedState,
			})
			expect(loadStdout).toContain(`loaded auth state into ${hydratedWatcherId}`)

			const { stdout: hydratedStateStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', hydratedWatcherId], { env })
			const hydratedState = JSON.parse(hydratedStateStdout) as AuthStateSnapshot

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, hydratedWatcherId)
		} finally {
			await stopProcess(watcherProc)
			await stopProcess(chromeProc)
		}
	}, 20_000)

	test('auth clone copies auth state directly between watchers', async () => {
		const { chromeProc, watcherProc, watcherId: clonedWatcherId } = await startFreshWatchedSession(blankUrl, 'clone-auth')

		try {
			const { stdout: cloneStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'clone', watcherId, '--to', clonedWatcherId], { env })
			expect(cloneStdout).toContain(`cloned auth state from ${watcherId} to ${clonedWatcherId}`)

			const { stdout: hydratedStateStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', clonedWatcherId], { env })
			const hydratedState = JSON.parse(hydratedStateStdout) as AuthStateSnapshot

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, clonedWatcherId)
		} finally {
			await stopProcess(watcherProc)
			await stopProcess(chromeProc)
		}
	}, 20_000)

	test('start --auth-from launches a fresh watcher with cloned auth state', async () => {
		const startedWatcherId = `start-auth-${Date.now()}`
		const { proc: startProc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'start', '--id', startedWatcherId, '--auth-from', watcherId, '--headless', '--json'],
			{ env },
			new RegExp(`\\{"id":"${startedWatcherId}"`),
		)

		try {
			const startInfo = JSON.parse(stdout.trim()) as { id: string }
			expect(startInfo.id).toBe(startedWatcherId)

			const { stdout: hydratedStateStdout } = await runCommand('bun', [BIN_PATH, 'auth', 'export-state', startedWatcherId], { env })
			const hydratedState = JSON.parse(hydratedStateStdout) as AuthStateSnapshot

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, startedWatcherId)
		} finally {
			await stopProcess(startProc)
		}
	}, 20_000)

	test('chrome start rejects auth-state with copied profiles', async () => {
		const authStatePath = path.join(tempDir, 'invalid-combo-auth-state.json')
		await runCommand('bun', [BIN_PATH, 'auth', 'export-state', watcherId, '--out', authStatePath], { env })

		const result = await runCommandWithExit(
			'bun',
			[BIN_PATH, 'chrome', 'start', '--auth-state', authStatePath, '--profile', 'default-lite', '--json'],
			{ env },
		)

		expect(result.code).toBe(2)
		expect(result.stderr).toContain('Cannot combine --auth-state with a copied Chrome profile')
	})
})
