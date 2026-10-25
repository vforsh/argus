import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import path from 'node:path'
import type { AuthCookiesResponse, AuthStateSnapshot } from '@vforsh/argus-core'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import type { Cli } from '../helpers/cli.js'
import { BIN_PATH } from '../helpers/paths.js'
import { spawnAndWait, stopProcess } from '../helpers/process.js'
import { startSite, type Site } from '../helpers/site.js'
import { TIMEOUTS } from '../helpers/timeouts.js'
import { waitForWatcherAttached } from '../helpers/watcher.js'

setDefaultTimeout(TIMEOUTS.browser)

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
	let fx: CdpFixture
	let cli: Cli
	let watcherId: string
	let site: Site
	let fixtureUrl: string
	let blankUrl: string

	beforeAll(async () => {
		watcherId = `auth-e2e-${Date.now()}`

		site = await startSite((req, res) => {
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
		fixtureUrl = `http://app.localhost:${site.port}/`
		blankUrl = `http://app.localhost:${site.port}/blank`

		fx = await startCdpFixture({
			prefix: 'argus-auth-e2e',
			watcher: { id: watcherId, match: { title: 'auth-e2e' } },
			preparePage: async (page) => {
				await page.goto(`http://auth.localhost:${site.port}/auth-seed`)
				await page.goto(fixtureUrl)
				await page.evaluate(() => {
					localStorage.setItem('accessToken', 'storage-access-secret')
					sessionStorage.setItem('csrfToken', 'session-csrf-secret')
				})
			},
		})
		cli = fx.cli
	})

	afterAll(async () => {
		await fx?.close()
		await site?.close()
	})

	const startFreshWatchedSession = async (url: string, watcherIdPrefix: string) => {
		const { proc: chromeProc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'chrome', 'start', '--url', url, '--headless', '--json'],
			{ env: fx.env },
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
			{ env: fx.env },
			new RegExp(`\\{"id":"${freshWatcherId}"`),
		)

		// The watcher prints its id before it has attached, so a command issued right after
		// this returns can fail with "Watcher not attached to a CDP target".
		await waitForWatcherAttached(BIN_PATH, freshWatcherId, { env: fx.env })

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
		const { stdout } = await cli.run(['auth', 'cookies', watcherId])

		expect(stdout).toContain('starkuser')
		expect(stdout).toContain('csrftoken')
		expect(stdout).not.toContain('session-cookie-secret')
	})

	test('auth cookies --json --show-values returns raw cookie values', async () => {
		const response = await cli.json<AuthCookiesResponse>(['auth', 'cookies', watcherId, '--json', '--show-values'])
		const sessionCookie = response.cookies.find((cookie) => cookie.name === 'starkuser')

		expect(response.ok).toBe(true)
		expect(sessionCookie?.value).toBe('session-cookie-secret')
	})

	test('auth export-cookies emits Netscape format', async () => {
		const { stdout } = await cli.run(['auth', 'export-cookies', watcherId, '--format', 'netscape'])

		expect(stdout).toContain('# Netscape HTTP Cookie File')
		expect(stdout).toContain('#HttpOnly_app.localhost')
		expect(stdout).toContain('starkuser\tsession-cookie-secret')
	})

	test('auth cookies --exclude-tracking hides analytics cookies', async () => {
		const { stdout } = await cli.run(['auth', 'cookies', watcherId, '--exclude-tracking'])

		expect(stdout).toContain('starkuser')
		expect(stdout).not.toContain('_ga')
	})

	test('auth export-state includes cookies and storage for the active page', async () => {
		const snapshot = await cli.json<AuthStateSnapshot>(['auth', 'export-state', watcherId])

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
		const authStatePath = path.join(fx.home, 'auth-state.json')
		await cli.run(['auth', 'export-state', watcherId, '--out', authStatePath])

		const { proc: chromeProc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'chrome', 'start', '--auth-state', authStatePath, '--headless', '--json'],
			{ env: fx.env },
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
				{ env: fx.env },
				new RegExp(`\\{"id":"${hydratedWatcherId}"`),
			)

			try {
				const hydratedState = await cli.json<AuthStateSnapshot>(['auth', 'export-state', hydratedWatcherId])

				expectHydratedFixtureState(hydratedState)
				expect(hydratedState.cookies.some((cookie) => cookie.name === 'csrftoken' && cookie.value === 'csrf-cookie-secret')).toBe(true)
				expectSnapshotMetadata(hydratedState, hydratedWatcherId)
			} finally {
				await stopProcess(watcherProc)
			}
		} finally {
			await stopProcess(chromeProc)
		}
	})

	test('auth load-state hydrates an already running watcher tab', async () => {
		const authStatePath = path.join(fx.home, 'live-auth-state.json')
		await cli.run(['auth', 'export-state', watcherId, '--out', authStatePath])

		const { chromeProc, watcherProc, watcherId: hydratedWatcherId } = await startFreshWatchedSession(blankUrl, 'live-auth')
		try {
			const { stdout: loadStdout } = await cli.run(['auth', 'load-state', hydratedWatcherId, '--in', authStatePath])
			expect(loadStdout).toContain(`loaded auth state into ${hydratedWatcherId}`)

			const hydratedState = await cli.json<AuthStateSnapshot>(['auth', 'export-state', hydratedWatcherId])

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, hydratedWatcherId)
		} finally {
			await stopProcess(watcherProc)
			await stopProcess(chromeProc)
		}
	})

	test('auth load-state accepts snapshots from stdin', async () => {
		const { stdout: exportedState } = await cli.run(['auth', 'export-state', watcherId])
		const { chromeProc, watcherProc, watcherId: hydratedWatcherId } = await startFreshWatchedSession(blankUrl, 'stdin-auth')

		try {
			const { stdout: loadStdout } = await cli.run(['auth', 'load-state', hydratedWatcherId, '--in', '-'], { input: exportedState })
			expect(loadStdout).toContain(`loaded auth state into ${hydratedWatcherId}`)

			const hydratedState = await cli.json<AuthStateSnapshot>(['auth', 'export-state', hydratedWatcherId])

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, hydratedWatcherId)
		} finally {
			await stopProcess(watcherProc)
			await stopProcess(chromeProc)
		}
	})

	test('auth clone copies auth state directly between watchers', async () => {
		const { chromeProc, watcherProc, watcherId: clonedWatcherId } = await startFreshWatchedSession(blankUrl, 'clone-auth')

		try {
			const { stdout: cloneStdout } = await cli.run(['auth', 'clone', watcherId, '--to', clonedWatcherId])
			expect(cloneStdout).toContain(`cloned auth state from ${watcherId} to ${clonedWatcherId}`)

			const hydratedState = await cli.json<AuthStateSnapshot>(['auth', 'export-state', clonedWatcherId])

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, clonedWatcherId)
		} finally {
			await stopProcess(watcherProc)
			await stopProcess(chromeProc)
		}
	})

	test('start --auth-from launches a fresh watcher with cloned auth state', async () => {
		const startedWatcherId = `start-auth-${Date.now()}`
		const { proc: startProc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'start', '--id', startedWatcherId, '--auth-from', watcherId, '--headless', '--json'],
			{ env: fx.env },
			new RegExp(`\\{"id":"${startedWatcherId}"`),
		)

		try {
			const startInfo = JSON.parse(stdout.trim()) as { id: string }
			expect(startInfo.id).toBe(startedWatcherId)

			const hydratedState = await cli.json<AuthStateSnapshot>(['auth', 'export-state', startedWatcherId])

			expectHydratedFixtureState(hydratedState)
			expectSnapshotMetadata(hydratedState, startedWatcherId)
		} finally {
			await stopProcess(startProc)
		}
	})

	test('chrome start rejects auth-state with copied profiles', async () => {
		const authStatePath = path.join(fx.home, 'invalid-combo-auth-state.json')
		await cli.run(['auth', 'export-state', watcherId, '--out', authStatePath])

		const result = await cli.exec(['chrome', 'start', '--auth-state', authStatePath, '--profile', 'default-lite', '--json'])

		expect(result.code).toBe(2)
		expect(result.stderr).toContain('Cannot combine --auth-state with a copied Chrome profile')
	})
})
