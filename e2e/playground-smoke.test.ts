import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium, type Browser } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'
import type { ChildProcess } from 'node:child_process'
import type { EvalResponse, DomTreeResponse, DomInfoResponse, StorageLocalListResponse, ScreenshotResponse } from '@vforsh/argus-core'
import type * as http from 'node:http'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

describe('playground smoke tests', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let watcherProc: ChildProcess
	let mainServer: http.Server
	let crossOriginServer: http.Server

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-playground-smoke-'))
		env = { ...process.env, ARGUS_HOME: tempDir }

		const debugPort = await getFreePort()
		const mainPort = await getFreePort()
		const crossOriginPort = await getFreePort()

		// 1. Start playground servers
		const { startServer } = await import('../playground/serve.js')

		mainServer = startServer({ port: mainPort, crossOriginPort })
		await new Promise<void>((resolve) => mainServer.on('listening', resolve))

		crossOriginServer = startServer({ port: crossOriginPort })
		await new Promise<void>((resolve) => crossOriginServer.on('listening', resolve))

		// 2. Launch browser
		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		const page = await context.newPage()
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
		let attached = false
		for (let i = 0; i < 50; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${watcherInfo.port}/status`)
				const status = (await res.json()) as { attached: boolean }
				if (status.attached) {
					attached = true
					break
				}
			} catch {
				// ignore connection errors during startup
			}
			await new Promise((r) => setTimeout(r, 200))
		}
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
