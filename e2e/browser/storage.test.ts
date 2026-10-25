import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Page } from 'playwright'
import type { StorageArea, StorageGetResponse, StorageKeyMutationResponse, StorageListResponse, StorageClearResponse } from '@vforsh/argus-core'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import type { Cli } from '../helpers/cli.js'
import { htmlPage, startSite, type Site } from '../helpers/site.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>storage-e2e</title></head>
<body><h1>Storage Test</h1></body>
</html>
`

describe('storage e2e', () => {
	let fx: CdpFixture
	let page: Page
	let cli: Cli
	let watcherId: string
	let site: Site

	beforeAll(async () => {
		watcherId = `storage-e2e-${Date.now()}`
		site = await startSite(htmlPage(TEST_HTML))

		fx = await startCdpFixture({
			prefix: 'argus-storage-e2e',
			watcher: { id: watcherId, match: { title: 'storage-e2e' } },
			preparePage: async (page) => {
				await page.goto(`${site.origin}/`)
				expect(await page.title()).toBe('storage-e2e')
			},
		})
		page = fx.page
		cli = fx.cli

		// startCdpFixture already waited for attachment; keep the suite's own check on it.
		const { attached } = (await (await fetch(`http://127.0.0.1:${fx.watcher.port}/status`)).json()) as { attached: boolean }
		expect(attached).toBe(true)
	})

	afterAll(async () => {
		await fx?.close()
		await site?.close()
	})

	registerStorageAreaTests('local')
	registerStorageAreaTests('session')

	function registerStorageAreaTests(area: StorageArea): void {
		test(`storage ${area} get returns null for missing key`, async () => {
			const { stdout } = await cli.run(['storage', area, 'get', watcherId, 'nonexistent'])
			expect(stdout.trim()).toBe('null')
		})

		test(`storage ${area} get --json returns proper structure for missing key`, async () => {
			const response = await cli.json<StorageGetResponse>(['storage', area, 'get', watcherId, 'nonexistent', '--json'])
			expect(response.ok).toBe(true)
			expect(response.exists).toBe(false)
			expect(response.value).toBeNull()
			expect(response.key).toBe('nonexistent')
		})

		test(`storage ${area} set stores a value`, async () => {
			const { stdout } = await cli.run(['storage', area, 'set', watcherId, 'testKey', 'testValue'])
			expect(stdout).toMatch(/Set testKey/)
			expect(await getStorageValue(area, 'testKey')).toBe('testValue')
		})

		test(`storage ${area} set --json returns proper structure`, async () => {
			const response = await cli.json<StorageKeyMutationResponse>(['storage', area, 'set', watcherId, 'jsonKey', 'jsonValue', '--json'])
			expect(response.ok).toBe(true)
			expect(response.key).toBe('jsonKey')
			expect(response.origin).toBeTruthy()
		})

		test(`storage ${area} get retrieves stored value`, async () => {
			await setStorageValue(area, 'getTestKey', 'getTestValue')
			const { stdout } = await cli.run(['storage', area, 'get', watcherId, 'getTestKey'])
			expect(stdout.trim()).toBe('getTestValue')
		})

		test(`storage ${area} get --json returns proper structure for existing key`, async () => {
			await setStorageValue(area, 'existingKey', 'existingValue')

			const response = await cli.json<StorageGetResponse>(['storage', area, 'get', watcherId, 'existingKey', '--json'])
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

			const { stdout } = await cli.run(['storage', area, 'list', watcherId])
			expect(stdout.trim().split('\n')).toEqual(['apple', 'mango', 'zebra'])
		})

		test(`storage ${area} list --json returns proper structure`, async () => {
			const response = await cli.json<StorageListResponse>(['storage', area, 'list', watcherId, '--json'])
			expect(response.ok).toBe(true)
			expect(response.keys).toEqual(['apple', 'mango', 'zebra'])
		})

		test(`storage ${area} remove deletes a key`, async () => {
			await setStorageValue(area, 'toRemove', 'value')

			const { stdout } = await cli.run(['storage', area, 'remove', watcherId, 'toRemove'])
			expect(stdout).toMatch(/Removed toRemove/)
			expect(await getStorageValue(area, 'toRemove')).toBeNull()
		})

		test(`storage ${area} remove --json returns proper structure`, async () => {
			await setStorageValue(area, 'toRemoveJson', 'value')

			const response = await cli.json<StorageKeyMutationResponse>(['storage', area, 'remove', watcherId, 'toRemoveJson', '--json'])
			expect(response.ok).toBe(true)
			expect(response.key).toBe('toRemoveJson')
		})

		test(`storage ${area} clear removes all items`, async () => {
			await replaceStorageEntries(area, [
				['a', '1'],
				['b', '2'],
				['c', '3'],
			])

			const { stdout } = await cli.run(['storage', area, 'clear', watcherId])
			expect(stdout).toMatch(/Cleared 3 item/)
			expect(await getStorageLength(area)).toBe(0)
		})

		test(`storage ${area} clear --json returns proper structure`, async () => {
			await replaceStorageEntries(area, [
				['x', '1'],
				['y', '2'],
			])

			const response = await cli.json<StorageClearResponse>(['storage', area, 'clear', watcherId, '--json'])
			expect(response.ok).toBe(true)
			expect(response.cleared).toBe(2)
		})

		test(`storage ${area} set stores JSON string correctly`, async () => {
			const jsonValue = '{"debug":true,"count":42}'
			await cli.run(['storage', area, 'set', watcherId, 'jsonData', jsonValue])
			expect(await getStorageValue(area, 'jsonData')).toBe(jsonValue)
		})

		test(`storage ${area} origin mismatch returns error`, async () => {
			const result = await cli.run(['storage', area, 'get', watcherId, 'anyKey', '--origin', 'https://wrong-origin.com']).catch((error) => error)

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
