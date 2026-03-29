import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait, stopProcess } from './helpers/process.js'
import type { ChildProcess } from 'node:child_process'
import type { StorageArea, StorageGetResponse, StorageKeyMutationResponse, StorageListResponse, StorageClearResponse } from '@vforsh/argus-core'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>storage-e2e</title></head>
<body><h1>Storage Test</h1></body>
</html>
`

describe('storage e2e', () => {
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

		httpServer = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(TEST_HTML)
		})
		await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve))

		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		page = await context.newPage()
		await page.goto(`http://127.0.0.1:${httpPort}/`)

		expect(await page.title()).toBe('storage-e2e')

		const watcherConfig = {
			id: watcherId,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { title: 'storage-e2e' },
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

		const watcherInfo = JSON.parse(watcherStdout) as { port: number }
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

	registerStorageAreaTests('local')
	registerStorageAreaTests('session')

	function registerStorageAreaTests(area: StorageArea): void {
		test(`storage ${area} get returns null for missing key`, async () => {
			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'get', watcherId, 'nonexistent'], { env })
			expect(stdout.trim()).toBe('null')
		})

		test(`storage ${area} get --json returns proper structure for missing key`, async () => {
			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'get', watcherId, 'nonexistent', '--json'], { env })
			const response = JSON.parse(stdout) as StorageGetResponse
			expect(response.ok).toBe(true)
			expect(response.exists).toBe(false)
			expect(response.value).toBeNull()
			expect(response.key).toBe('nonexistent')
		})

		test(`storage ${area} set stores a value`, async () => {
			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'set', watcherId, 'testKey', 'testValue'], { env })
			expect(stdout).toMatch(/Set testKey/)
			expect(await getStorageValue(area, 'testKey')).toBe('testValue')
		})

		test(`storage ${area} set --json returns proper structure`, async () => {
			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'set', watcherId, 'jsonKey', 'jsonValue', '--json'], { env })
			const response = JSON.parse(stdout) as StorageKeyMutationResponse
			expect(response.ok).toBe(true)
			expect(response.key).toBe('jsonKey')
			expect(response.origin).toBeTruthy()
		})

		test(`storage ${area} get retrieves stored value`, async () => {
			await setStorageValue(area, 'getTestKey', 'getTestValue')
			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'get', watcherId, 'getTestKey'], { env })
			expect(stdout.trim()).toBe('getTestValue')
		})

		test(`storage ${area} get --json returns proper structure for existing key`, async () => {
			await setStorageValue(area, 'existingKey', 'existingValue')

			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'get', watcherId, 'existingKey', '--json'], { env })
			const response = JSON.parse(stdout) as StorageGetResponse
			expect(response.ok).toBe(true)
			expect(response.exists).toBe(true)
			expect(response.value).toBe('existingValue')
			expect(response.key).toBe('existingKey')
		})

		test(`storage ${area} list returns all keys sorted`, async () => {
			await replaceStorageEntries(area, [
				['zebra', '1'],
				['apple', '2'],
				['mango', '3'],
			])

			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'list', watcherId], { env })
			expect(stdout.trim().split('\n')).toEqual(['apple', 'mango', 'zebra'])
		})

		test(`storage ${area} list --json returns proper structure`, async () => {
			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'list', watcherId, '--json'], { env })
			const response = JSON.parse(stdout) as StorageListResponse
			expect(response.ok).toBe(true)
			expect(response.keys).toEqual(['apple', 'mango', 'zebra'])
		})

		test(`storage ${area} remove deletes a key`, async () => {
			await setStorageValue(area, 'toRemove', 'value')

			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'remove', watcherId, 'toRemove'], { env })
			expect(stdout).toMatch(/Removed toRemove/)
			expect(await getStorageValue(area, 'toRemove')).toBeNull()
		})

		test(`storage ${area} remove --json returns proper structure`, async () => {
			await setStorageValue(area, 'toRemoveJson', 'value')

			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'remove', watcherId, 'toRemoveJson', '--json'], { env })
			const response = JSON.parse(stdout) as StorageKeyMutationResponse
			expect(response.ok).toBe(true)
			expect(response.key).toBe('toRemoveJson')
		})

		test(`storage ${area} clear removes all items`, async () => {
			await replaceStorageEntries(area, [
				['a', '1'],
				['b', '2'],
				['c', '3'],
			])

			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'clear', watcherId], { env })
			expect(stdout).toMatch(/Cleared 3 item/)
			expect(await getStorageLength(area)).toBe(0)
		})

		test(`storage ${area} clear --json returns proper structure`, async () => {
			await replaceStorageEntries(area, [
				['x', '1'],
				['y', '2'],
			])

			const { stdout } = await runCommand('bun', [BIN_PATH, 'storage', area, 'clear', watcherId, '--json'], { env })
			const response = JSON.parse(stdout) as StorageClearResponse
			expect(response.ok).toBe(true)
			expect(response.cleared).toBe(2)
		})

		test(`storage ${area} set stores JSON string correctly`, async () => {
			const jsonValue = '{"debug":true,"count":42}'
			await runCommand('bun', [BIN_PATH, 'storage', area, 'set', watcherId, 'jsonData', jsonValue], { env })
			expect(await getStorageValue(area, 'jsonData')).toBe(jsonValue)
		})

		test(`storage ${area} origin mismatch returns error`, async () => {
			const result = await runCommand('bun', [BIN_PATH, 'storage', area, 'get', watcherId, 'anyKey', '--origin', 'https://wrong-origin.com'], {
				env,
			}).catch((error) => error)

			expect(result).toBeInstanceOf(Error)
			expect(result.message).toMatch(/Origin mismatch/)
		})
	}

	async function getStorageLength(area: StorageArea): Promise<number> {
		return page.evaluate((targetArea) => {
			const storage = targetArea === 'local' ? window.localStorage : window.sessionStorage
			return storage.length
		}, area)
	}

	async function getStorageValue(area: StorageArea, key: string): Promise<string | null> {
		return page.evaluate(
			({ targetArea, targetKey }) => {
				const storage = targetArea === 'local' ? window.localStorage : window.sessionStorage
				return storage.getItem(targetKey)
			},
			{ targetArea: area, targetKey: key },
		)
	}

	async function setStorageValue(area: StorageArea, key: string, value: string): Promise<void> {
		await page.evaluate(
			({ targetArea, targetKey, targetValue }) => {
				const storage = targetArea === 'local' ? window.localStorage : window.sessionStorage
				storage.setItem(targetKey, targetValue)
			},
			{ targetArea: area, targetKey: key, targetValue: value },
		)
	}

	async function replaceStorageEntries(area: StorageArea, entries: Array<[string, string]>): Promise<void> {
		await page.evaluate(
			({ targetArea, nextEntries }) => {
				const storage = targetArea === 'local' ? window.localStorage : window.sessionStorage
				storage.clear()
				for (const [key, value] of nextEntries) {
					storage.setItem(key, value)
				}
			},
			{ targetArea: area, nextEntries: entries },
		)
	}
})
