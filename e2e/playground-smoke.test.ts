import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium, type Browser } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'
import type { ChildProcess } from 'node:child_process'
import type {
	CodeListResponse,
	DialogHandleResponse,
	DialogStatusResponse,
	DomInfoResponse,
	DomTreeResponse,
	EvalResponse,
	ScreenshotResponse,
	StorageLocalListResponse,
} from '@vforsh/argus-core'
import type { Page } from 'playwright'
import type * as http from 'node:http'
import { startPlaygroundServers, waitForWatcherReady } from '../playground/harness.ts'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

describe('playground smoke tests', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let page: Page
	let watcherProc: ChildProcess
	let mainServer: http.Server
	let crossOriginServer: http.Server

	const findResourceUrl = async (needle: string): Promise<string> => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'code', 'ls', 'playground', '--json'], { env })
		const response = JSON.parse(stdout) as CodeListResponse
		const resource = response.resources.find((entry) => entry.url.includes(needle))
		expect(resource).toBeTruthy()
		return resource!.url
	}

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-playground-smoke-'))
		env = { ...process.env, ARGUS_HOME: tempDir }

		const debugPort = await getFreePort()
		const mainPort = await getFreePort()
		const crossOriginPort = await getFreePort()

		// 1. Start playground servers
		const servers = startPlaygroundServers({ port: mainPort, crossOriginPort })
		mainServer = servers.mainServer
		crossOriginServer = servers.crossOriginServer
		await new Promise<void>((resolve) => mainServer.on('listening', resolve))
		await new Promise<void>((resolve) => crossOriginServer.on('listening', resolve))

		// 2. Launch browser
		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		page = await context.newPage()
		await page.goto(`http://127.0.0.1:${mainPort}/`)

		const title = await page.title()
		expect(title).toBe('Argus Playground')

		// 3. Start watcher
		const watcherConfig = {
			id: 'playground',
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { url: `127.0.0.1:${mainPort}` },
			host: '127.0.0.1',
			port: 0,
		}

		const { proc, stdout: watcherStdout } = await spawnAndWait(
			'bun',
			[FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
			{ env },
			/\{"id":"playground"/,
		)
		watcherProc = proc

		const watcherInfo = JSON.parse(watcherStdout)

		// 4. Wait for attachment
		const attached = await waitForWatcherReady(watcherInfo.port)
		expect(attached).toBe(true)
	})

	afterAll(async () => {
		watcherProc?.kill('SIGTERM')
		await browser?.close()
		await new Promise<void>((resolve) => {
			if (!mainServer) return resolve()
			mainServer.close(() => resolve())
		})
		await new Promise<void>((resolve) => {
			if (!crossOriginServer) return resolve()
			crossOriginServer.close(() => resolve())
		})
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	// ─────────────────────────────────────────────────────────────────────────
	// eval-until
	// ─────────────────────────────────────────────────────────────────────────

	test('eval-until waits for playground.ready', async () => {
		const { stdout } = await runCommand(
			'bun',
			[BIN_PATH, 'eval-until', 'playground', 'window.playground.ready', '--json', '--total-timeout', '10000'],
			{ env },
		)
		const response = JSON.parse(stdout) as EvalResponse
		expect(response.ok).toBe(true)
		expect(response.result).toBe(true)
	})

	test('eval supports native top-level await', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'eval', 'playground', 'await Promise.resolve(42)', '--json'], { env })
		const response = JSON.parse(stdout) as EvalResponse
		expect(response.ok).toBe(true)
		expect(response.result).toBe(42)
	})

	test('eval supports top-level await from --file', async () => {
		const scriptPath = path.join(tempDir, 'top-level-await.js')
		await fs.writeFile(scriptPath, 'const value = await Promise.resolve(41)\nvalue + 1\n', 'utf8')

		const { stdout } = await runCommand('bun', [BIN_PATH, 'eval', 'playground', '--file', scriptPath, '--json'], { env })
		const response = JSON.parse(stdout) as EvalResponse
		expect(response.ok).toBe(true)
		expect(response.result).toBe(42)
	})

	test('eval preserves promise-resolved object values', async () => {
		const { stdout } = await runCommand(
			'bun',
			[BIN_PATH, 'eval', 'playground', 'Promise.resolve({ answer: 42, nested: { ok: true }, list: [1, 2] })', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as EvalResponse
		expect(response.ok).toBe(true)
		expect(response.result).toEqual({
			answer: 42,
			nested: { ok: true },
			list: [1, 2],
		})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom tree
	// ─────────────────────────────────────────────────────────────────────────

	test('dom tree returns body subtree', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'tree', 'playground', '--selector', 'body', '--depth', '2', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomTreeResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.roots[0].tag).toBe('body')
		expect(response.roots[0].children && response.roots[0].children.length > 0).toBe(true)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// dom info
	// ─────────────────────────────────────────────────────────────────────────

	test('dom info returns article-1 details', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'dom', 'info', 'playground', '--selector', '[data-testid="article-1"]', '--json'], {
			env,
		})
		const response = JSON.parse(stdout) as DomInfoResponse
		expect(response.ok).toBe(true)
		expect(response.matches).toBe(1)
		expect(response.elements[0].tag).toBe('article')
		expect(response.elements[0].attributes['data-testid']).toBe('article-1')
		expect(response.elements[0].childElementCount).toBe(2)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// storage local list
	// ─────────────────────────────────────────────────────────────────────────

	test('storage local list returns seeded keys', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'list', 'playground', '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalListResponse
		expect(response.ok).toBe(true)
		expect(response.keys).toContain('playground:name')
		expect(response.keys).toContain('playground:version')
		expect(response.keys).toContain('playground:config')
	})

	// ─────────────────────────────────────────────────────────────────────────
	// runtime code
	// ─────────────────────────────────────────────────────────────────────────

	test('code deminify formats minified runtime resources', async () => {
		const resourceUrl = await findResourceUrl('/minified-app.js')
		const { stdout } = await runCommand('bun', [BIN_PATH, 'code', 'deminify', resourceUrl, '--id', 'playground', '--json'], { env })
		const response = JSON.parse(stdout) as { ok: boolean; changed: boolean; source: string; formatError: string | null }
		expect(response.ok).toBe(true)
		expect(response.changed).toBe(true)
		expect(response.formatError).toBeNull()
		expect(response.source).toContain('window.minifiedFixture = {')
		expect(response.source).toContain('showLogsByHost: "/admin/api/showLogsByHost"')
	})

	test('code strings extracts high-signal runtime strings', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'code', 'strings', 'playground', '--url', 'minified-app.js', '--json'], { env })
		const response = JSON.parse(stdout) as {
			ok: boolean
			matches: Array<{ value: string; kind: string }>
		}
		expect(response.ok).toBe(true)
		expect(response.matches.some((match) => match.value === '/admin/api/showLogsByHost' && match.kind === 'url')).toBe(true)
		expect(response.matches.some((match) => match.value === 'playground:feature.flag' && match.kind === 'key')).toBe(true)
		expect(response.matches.some((match) => match.value === 'showLogsByHost' && match.kind === 'identifier')).toBe(true)
		expect(response.matches[0]?.kind).toBe('url')
		expect(response.matches[0]?.value.startsWith('/admin/api/')).toBe(true)
	})

	test('code strings supports kind and match filters', async () => {
		const { stdout } = await runCommand(
			'bun',
			[BIN_PATH, 'code', 'strings', 'playground', '--url', 'minified-app.js', '--kind', 'identifier', '--match', 'showLogs', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as {
			ok: boolean
			matches: Array<{ value: string; kind: string }>
		}
		expect(response.ok).toBe(true)
		expect(response.matches.length).toBeGreaterThan(0)
		expect(response.matches.every((match) => match.kind === 'identifier')).toBe(true)
		expect(response.matches.every((match) => match.value.includes('showLogs'))).toBe(true)
	})

	test('code grep pretty shows clipped context around matches', async () => {
		const { stdout } = await runCommand(
			'bun',
			[BIN_PATH, 'code', 'grep', 'showLogsByHost', '--id', 'playground', '--url', 'minified-app.js', '--pretty'],
			{ env },
		)
		expect(stdout).toContain('minified-app.js')
		expect(stdout).toContain('[[showLogsByHost]]')
		expect(stdout).toContain('/admin/api/showLogsByHost')
	})

	// ─────────────────────────────────────────────────────────────────────────
	// eval in iframes
	// ─────────────────────────────────────────────────────────────────────────

	test('eval in same-origin iframe', async () => {
		const { stdout } = await runCommand(
			'bun',
			[BIN_PATH, 'eval', 'playground', 'window.iframeState', '--iframe', '#playground-iframe', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as EvalResponse
		expect(response.ok).toBe(true)
		const result = response.result as { loaded: boolean; title: string }
		expect(result.loaded).toBe(true)
		expect(result.title).toBe('Playground Iframe')
	})

	test('eval in cross-origin iframe', async () => {
		const { stdout } = await runCommand(
			'bun',
			[BIN_PATH, 'eval', 'playground', 'window.iframeState', '--iframe', '#cross-origin-iframe', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as EvalResponse
		expect(response.ok).toBe(true)
		const result = response.result as { loaded: boolean; title: string }
		expect(result.loaded).toBe(true)
		expect(result.title).toBe('Playground Iframe')
	})

	test(
		'dialog commands work against playground dialogs',
		{
			timeout: 15_000,
		},
		async () => {
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

			const fetchDialogStatus = async (): Promise<DialogStatusResponse> => {
				const { stdout } = await runCommand('bun', [BIN_PATH, 'dialog', 'status', 'playground', '--json'], { env })
				return JSON.parse(stdout) as DialogStatusResponse
			}

			const waitForDialog = async (type: NonNullable<DialogStatusResponse['dialog']>['type']) => {
				for (let i = 0; i < 40; i += 1) {
					const status = await fetchDialogStatus()
					if (status.dialog?.type === type) {
						return status.dialog
					}
					await sleep(100)
				}
				throw new Error(`Timed out waiting for ${type} dialog`)
			}

			const waitForNoDialog = async (): Promise<void> => {
				for (let i = 0; i < 40; i += 1) {
					const status = await fetchDialogStatus()
					if (!status.dialog) {
						return
					}
					await sleep(100)
				}
				throw new Error('Timed out waiting for dialog to close')
			}

			const waitForPlaygroundDialogResult = async () => {
				for (let i = 0; i < 40; i += 1) {
					const result = await page.evaluate(() => {
						const state = window as Window & {
							__dialogResults?: Array<{ state?: string; result?: string | boolean | null }>
						}
						const entry = state.__dialogResults?.at(-1)
						if (!entry || entry.state !== 'resolved') {
							return null
						}
						return entry.result ?? null
					})
					if (result !== null) {
						return result
					}
					await sleep(100)
				}
				throw new Error('Timed out waiting for playground dialog result')
			}

			const openPlaygroundDialog = async (buttonTestId: string) => {
				let releaseDialog: (() => void) | null = null
				const holdDialog = new Promise<void>((resolve) => {
					releaseDialog = resolve
				})

				const browserDialog = new Promise<{ type: string; message: string; defaultValue: string }>((resolve) => {
					page.once('dialog', async (dialog) => {
						resolve({
							type: dialog.type(),
							message: dialog.message(),
							defaultValue: dialog.defaultValue(),
						})
						await holdDialog
					})
				})

				await page.getByTestId(buttonTestId).evaluate((element: HTMLElement) => {
					element.click()
				})

				return {
					dialog: await browserDialog,
					release: () => releaseDialog?.(),
				}
			}

			const alertOpen = await openPlaygroundDialog('btn-dialog-alert')
			expect(alertOpen.dialog.type).toBe('alert')
			expect(alertOpen.dialog.message).toBe('playground alert message')
			const alertStatus = await waitForDialog('alert')
			expect(alertStatus.message).toBe('playground alert message')
			await runCommand('bun', [BIN_PATH, 'dialog', 'accept', 'playground'], { env })
			alertOpen.release()
			await waitForNoDialog()
			expect(await waitForPlaygroundDialogResult()).toBe('accepted')

			const confirmOpen = await openPlaygroundDialog('btn-dialog-confirm')
			expect(confirmOpen.dialog.type).toBe('confirm')
			const confirmStatus = await waitForDialog('confirm')
			expect(confirmStatus.message).toBe('playground confirm message')
			await runCommand('bun', [BIN_PATH, 'dialog', 'dismiss', 'playground'], { env })
			confirmOpen.release()
			await waitForNoDialog()
			expect(await waitForPlaygroundDialogResult()).toBe(false)

			const promptOpen = await openPlaygroundDialog('btn-dialog-prompt')
			expect(promptOpen.dialog.type).toBe('prompt')
			expect(promptOpen.dialog.defaultValue).toBe('seed value')
			const promptStatus = await waitForDialog('prompt')
			expect(promptStatus.message).toBe('playground prompt message')
			expect(promptStatus.defaultPrompt).toBe('seed value')

			const { stdout: promptHandleOut } = await runCommand(
				'bun',
				[BIN_PATH, 'dialog', 'prompt', 'playground', '--text', 'playground override', '--json'],
				{ env },
			)
			const promptHandle = JSON.parse(promptHandleOut) as DialogHandleResponse
			expect(promptHandle.action).toBe('accept')
			expect(promptHandle.dialog.type).toBe('prompt')
			promptOpen.release()
			await waitForNoDialog()
			expect(await waitForPlaygroundDialogResult()).toBe('playground override')
		},
	)

	// ─────────────────────────────────────────────────────────────────────────
	// screenshot
	// ─────────────────────────────────────────────────────────────────────────

	test('screenshot saves a file', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'screenshot', 'playground', '--json'], { env })
		const response = JSON.parse(stdout) as ScreenshotResponse
		expect(response.ok).toBe(true)
		expect(response.outFile).toBeTruthy()
		const stat = await fs.stat(response.outFile)
		expect(stat.size).toBeGreaterThan(0)
	})
})
