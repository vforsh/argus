import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'
import type { ChildProcess } from 'node:child_process'
import type {
	StorageLocalGetResponse,
	StorageLocalSetResponse,
	StorageLocalRemoveResponse,
	StorageLocalListResponse,
	StorageLocalClearResponse,
} from '@vforsh/argus-core'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>storage-local-e2e</title></head>
<body><h1>Storage Test</h1></body>
</html>
`

describe('storage local e2e', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let page: Page
	let watcherProc: ChildProcess
	let watcherId: string
	let httpServer: http.Server

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-storage-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const debugPort = await getFreePort()
		const httpPort = await getFreePort()
		watcherId = `storage-e2e-${Date.now()}`

		// Start a simple HTTP server to serve HTML (needed for localStorage access)
		httpServer = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(TEST_HTML)
		})
		await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve))

		// 1. Launch browser
		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		page = await context.newPage()
		await page.goto(`http://127.0.0.1:${httpPort}/`)

		const title = await page.title()
		expect(title).toBe('storage-local-e2e')

		// 2. Start watcher
		const watcherConfig = {
			id: watcherId,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { title: 'storage-local-e2e' },
			host: '127.0.0.1',
			port: 0,
		}

		const { proc, stdout: watcherStdout } = await spawnAndWait(
			'bun',
			[FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
			{ env },
			/\{"id":"storage-e2e-/,
		)
		watcherProc = proc

		const watcherInfo = JSON.parse(watcherStdout)

		// 3. Wait for attachment
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
		await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	// ─────────────────────────────────────────────────────────────────────────
	// storage local tests
	// ─────────────────────────────────────────────────────────────────────────

	test('storage local get returns null for missing key', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'nonexistent'], { env })
		expect(stdout.trim()).toBe('null')
	})

	test('storage local get --json returns proper structure for missing key', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'nonexistent', '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalGetResponse
		expect(response.ok).toBe(true)
		expect(response.exists).toBe(false)
		expect(response.value).toBeNull()
		expect(response.key).toBe('nonexistent')
	})

	test('storage local set stores a value', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'set', watcherId, 'testKey', 'testValue'], { env })
		expect(stdout).toMatch(/Set testKey/)

		// Verify via page.evaluate
		const storedValue = await page.evaluate(() => localStorage.getItem('testKey'))
		expect(storedValue).toBe('testValue')
	})

	test('storage local set --json returns proper structure', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'set', watcherId, 'jsonKey', 'jsonValue', '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalSetResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('jsonKey')
		expect(response.origin).toBeTruthy()
	})

	test('storage local get retrieves stored value', async () => {
		// First set a value via page
		await page.evaluate(() => localStorage.setItem('getTestKey', 'getTestValue'))

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'getTestKey'], { env })
		expect(stdout.trim()).toBe('getTestValue')
	})

	test('storage local get --json returns proper structure for existing key', async () => {
		await page.evaluate(() => localStorage.setItem('existingKey', 'existingValue'))

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'existingKey', '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalGetResponse
		expect(response.ok).toBe(true)
		expect(response.exists).toBe(true)
		expect(response.value).toBe('existingValue')
		expect(response.key).toBe('existingKey')
	})

	test('storage local list returns all keys sorted', async () => {
		// Clear and set known keys
		await page.evaluate(() => {
			localStorage.clear()
			localStorage.setItem('zebra', '1')
			localStorage.setItem('apple', '2')
			localStorage.setItem('mango', '3')
		})

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'list', watcherId], { env })
		const lines = stdout.trim().split('\n')
		expect(lines).toEqual(['apple', 'mango', 'zebra'])
	})

	test('storage local list --json returns proper structure', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'list', watcherId, '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalListResponse
		expect(response.ok).toBe(true)
		expect(Array.isArray(response.keys)).toBe(true)
		expect(response.keys).toEqual(['apple', 'mango', 'zebra'])
	})

	test('storage local remove deletes a key', async () => {
		await page.evaluate(() => localStorage.setItem('toRemove', 'value'))

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'remove', watcherId, 'toRemove'], { env })
		expect(stdout).toMatch(/Removed toRemove/)

		const storedValue = await page.evaluate(() => localStorage.getItem('toRemove'))
		expect(storedValue).toBeNull()
	})

	test('storage local remove --json returns proper structure', async () => {
		await page.evaluate(() => localStorage.setItem('toRemoveJson', 'value'))

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'remove', watcherId, 'toRemoveJson', '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalRemoveResponse
		expect(response.ok).toBe(true)
		expect(response.key).toBe('toRemoveJson')
	})

	test('storage local clear removes all items', async () => {
		// Clear first, then set exactly 3 items
		await page.evaluate(() => {
			localStorage.clear()
			localStorage.setItem('a', '1')
			localStorage.setItem('b', '2')
			localStorage.setItem('c', '3')
		})

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'clear', watcherId], { env })
		expect(stdout).toMatch(/Cleared 3 item/)

		const length = await page.evaluate(() => localStorage.length)
		expect(length).toBe(0)
	})

	test('storage local clear --json returns proper structure', async () => {
		await page.evaluate(() => {
			localStorage.setItem('x', '1')
			localStorage.setItem('y', '2')
		})

		const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'clear', watcherId, '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalClearResponse
		expect(response.ok).toBe(true)
		expect(response.cleared).toBe(2)
	})

	test('storage local set stores JSON string correctly', async () => {
		const jsonValue = '{"debug":true,"count":42}'
		await runCommand('bun', [BIN_PATH, 'storage', 'local', 'set', watcherId, 'jsonData', jsonValue], { env })

		const storedValue = await page.evaluate(() => localStorage.getItem('jsonData'))
		expect(storedValue).toBe(jsonValue)
	})

	test('origin mismatch returns error', async () => {
		// The CLI returns a non-zero exit code on origin mismatch
		const result = await runCommand('bun', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'anyKey', '--origin', 'https://wrong-origin.com'], {
			env,
		}).catch((e) => e)

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toMatch(/Origin mismatch/)
	})
})
