import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIgnoreMatcher } from '../packages/argus-watcher/src/cdp/ignoreList.js'
import { selectBestFrame } from '../packages/argus-watcher/src/cdp/selectBestFrame.js'

test('selectBestFrame skips ignored generated URL and picks next', async () => {
	const restoreFetch = mockFetch(() => ({ ok: false, json: async () => ({}) }))
	const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['ignored'] })
	assert.ok(ignoreMatcher)

	const selected = await selectBestFrame(
		[
			{ url: 'http://localhost/ignored.js', lineNumber: 0, columnNumber: 0 },
			{ url: 'http://localhost/app.js', lineNumber: 4, columnNumber: 2 },
		],
		ignoreMatcher,
	)

	assert.deepEqual(selected, { file: 'http://localhost/app.js', line: 5, column: 3 })
	restoreFetch()
})

test('selectBestFrame skips when sourcemapped source is ignored', async () => {
	const mapForIgnored = {
		version: 3,
		sources: ['webpack:///node_modules/ignored.ts'],
		names: [],
		mappings: 'AAAA',
	}
	const mapForAllowed = {
		version: 3,
		sources: ['src/app.ts'],
		names: [],
		mappings: 'AAAA',
	}
	const restoreFetch = mockFetch((url) => {
		if (url === 'http://localhost/first.js.map') {
			return { ok: true, json: async () => mapForIgnored }
		}
		if (url === 'http://localhost/second.js.map') {
			return { ok: true, json: async () => mapForAllowed }
		}
		return { ok: false, json: async () => ({}) }
	})

	const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['node_modules'] })
	assert.ok(ignoreMatcher)

	const selected = await selectBestFrame(
		[
			{ url: 'http://localhost/first.js', lineNumber: 0, columnNumber: 0 },
			{ url: 'http://localhost/second.js', lineNumber: 0, columnNumber: 0 },
		],
		ignoreMatcher,
	)

	assert.deepEqual(selected, { file: 'http://localhost/src/app.ts', line: 1, column: 1 })
	restoreFetch()
})

test('selectBestFrame returns null when all frames are ignored', async () => {
	const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['app.js'] })
	assert.ok(ignoreMatcher)

	const selected = await selectBestFrame([{ url: 'http://localhost/app.js', lineNumber: 1, columnNumber: 2 }], ignoreMatcher)
	assert.equal(selected, null)
})

test('buildIgnoreMatcher throws on invalid regex', () => {
	assert.throws(() => buildIgnoreMatcher({ enabled: true, rules: ['['] }), /Invalid ignoreList regex/)
})

const mockFetch = (
	handler: (url: string) => { ok: boolean; json: () => Promise<unknown> },
): (() => void) => {
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		return handler(url)
	}) as typeof fetch
	return () => {
		globalThis.fetch = previousFetch
	}
}
