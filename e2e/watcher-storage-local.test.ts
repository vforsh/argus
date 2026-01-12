import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import { chromium } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'
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

test('storage local e2e', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-storage-e2e-'))
	const env = { ...process.env, ARGUS_HOME: tempDir }
	const debugPort = await getFreePort()
	const httpPort = await getFreePort()
	const watcherId = `storage-e2e-${Date.now()}`

	// Start a simple HTTP server to serve HTML (needed for localStorage access)
	const httpServer = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/html' })
		res.end(TEST_HTML)
	})
	await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve))

	t.after(async () => {
		await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	})

	// 1. Launch browser
	const browser = await chromium.launch({
		args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
	})

	t.after(async () => {
		await browser.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const context = await browser.newContext()
	const page = await context.newPage()
	await page.goto(`http://127.0.0.1:${httpPort}/`)

	const title = await page.title()
	assert.equal(title, 'storage-local-e2e')

	// 2. Start watcher
	const watcherConfig = {
		id: watcherId,
		chrome: { host: '127.0.0.1', port: debugPort },
		match: { title: 'storage-local-e2e' },
		host: '127.0.0.1',
		port: 0,
	}

	const { proc: watcherProc, stdout: watcherStdout } = await spawnAndWait(
		'npx',
		['tsx', FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
		{ env },
		/\{"id":"storage-e2e-/,
	)

	t.after(async () => {
		watcherProc.kill('SIGTERM')
	})

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
	assert.ok(attached, 'Watcher should be attached to page')

	// ─────────────────────────────────────────────────────────────────────────
	// storage local tests
	// ─────────────────────────────────────────────────────────────────────────

	await t.test('storage local get returns null for missing key', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'nonexistent'], { env })
		assert.equal(stdout.trim(), 'null')
	})

	await t.test('storage local get --json returns proper structure for missing key', async () => {
		const { stdout } = await runCommand(
			'node',
			[BIN_PATH, 'storage', 'local', 'get', watcherId, 'nonexistent', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as StorageLocalGetResponse
		assert.equal(response.ok, true)
		assert.equal(response.exists, false)
		assert.equal(response.value, null)
		assert.equal(response.key, 'nonexistent')
	})

	await t.test('storage local set stores a value', async () => {
		const { stdout } = await runCommand(
			'node',
			[BIN_PATH, 'storage', 'local', 'set', watcherId, 'testKey', 'testValue'],
			{ env },
		)
		assert.match(stdout, /Set testKey/)

		// Verify via page.evaluate
		const storedValue = await page.evaluate(() => localStorage.getItem('testKey'))
		assert.equal(storedValue, 'testValue')
	})

	await t.test('storage local set --json returns proper structure', async () => {
		const { stdout } = await runCommand(
			'node',
			[BIN_PATH, 'storage', 'local', 'set', watcherId, 'jsonKey', 'jsonValue', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as StorageLocalSetResponse
		assert.equal(response.ok, true)
		assert.equal(response.key, 'jsonKey')
		assert.ok(response.origin)
	})

	await t.test('storage local get retrieves stored value', async () => {
		// First set a value via page
		await page.evaluate(() => localStorage.setItem('getTestKey', 'getTestValue'))

		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'get', watcherId, 'getTestKey'], { env })
		assert.equal(stdout.trim(), 'getTestValue')
	})

	await t.test('storage local get --json returns proper structure for existing key', async () => {
		await page.evaluate(() => localStorage.setItem('existingKey', 'existingValue'))

		const { stdout } = await runCommand(
			'node',
			[BIN_PATH, 'storage', 'local', 'get', watcherId, 'existingKey', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as StorageLocalGetResponse
		assert.equal(response.ok, true)
		assert.equal(response.exists, true)
		assert.equal(response.value, 'existingValue')
		assert.equal(response.key, 'existingKey')
	})

	await t.test('storage local list returns all keys sorted', async () => {
		// Clear and set known keys
		await page.evaluate(() => {
			localStorage.clear()
			localStorage.setItem('zebra', '1')
			localStorage.setItem('apple', '2')
			localStorage.setItem('mango', '3')
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'list', watcherId], { env })
		const lines = stdout.trim().split('\n')
		assert.deepEqual(lines, ['apple', 'mango', 'zebra'])
	})

	await t.test('storage local list --json returns proper structure', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'list', watcherId, '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalListResponse
		assert.equal(response.ok, true)
		assert.ok(Array.isArray(response.keys))
		assert.deepEqual(response.keys, ['apple', 'mango', 'zebra'])
	})

	await t.test('storage local remove deletes a key', async () => {
		await page.evaluate(() => localStorage.setItem('toRemove', 'value'))

		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'remove', watcherId, 'toRemove'], { env })
		assert.match(stdout, /Removed toRemove/)

		const storedValue = await page.evaluate(() => localStorage.getItem('toRemove'))
		assert.equal(storedValue, null)
	})

	await t.test('storage local remove --json returns proper structure', async () => {
		await page.evaluate(() => localStorage.setItem('toRemoveJson', 'value'))

		const { stdout } = await runCommand(
			'node',
			[BIN_PATH, 'storage', 'local', 'remove', watcherId, 'toRemoveJson', '--json'],
			{ env },
		)
		const response = JSON.parse(stdout) as StorageLocalRemoveResponse
		assert.equal(response.ok, true)
		assert.equal(response.key, 'toRemoveJson')
	})

	await t.test('storage local clear removes all items', async () => {
		// Clear first, then set exactly 3 items
		await page.evaluate(() => {
			localStorage.clear()
			localStorage.setItem('a', '1')
			localStorage.setItem('b', '2')
			localStorage.setItem('c', '3')
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'clear', watcherId], { env })
		assert.match(stdout, /Cleared 3 item/)

		const length = await page.evaluate(() => localStorage.length)
		assert.equal(length, 0)
	})

	await t.test('storage local clear --json returns proper structure', async () => {
		await page.evaluate(() => {
			localStorage.setItem('x', '1')
			localStorage.setItem('y', '2')
		})

		const { stdout } = await runCommand('node', [BIN_PATH, 'storage', 'local', 'clear', watcherId, '--json'], { env })
		const response = JSON.parse(stdout) as StorageLocalClearResponse
		assert.equal(response.ok, true)
		assert.equal(response.cleared, 2)
	})

	await t.test('storage local set stores JSON string correctly', async () => {
		const jsonValue = '{"debug":true,"count":42}'
		await runCommand('node', [BIN_PATH, 'storage', 'local', 'set', watcherId, 'jsonData', jsonValue], { env })

		const storedValue = await page.evaluate(() => localStorage.getItem('jsonData'))
		assert.equal(storedValue, jsonValue)
	})

	await t.test('origin mismatch returns error', async () => {
		// The CLI returns a non-zero exit code on origin mismatch
		// The error message includes "Origin mismatch" in stderr via Error: prefix
		const result = await runCommand(
			'node',
			[BIN_PATH, 'storage', 'local', 'get', watcherId, 'anyKey', '--origin', 'https://wrong-origin.com'],
			{ env },
		).catch((e) => e)

		assert.ok(result instanceof Error, 'Should throw on origin mismatch')
		// The error message should contain "Origin mismatch" in stderr
		assert.match(result.message, /Origin mismatch/)
	})
})
