import { test, expect } from 'bun:test'
import { resolveSourcemappedLocation } from '../packages/argus-watcher/src/sourcemaps/resolveLocation.js'

test('resolveSourcemappedLocation resolves generated locations through fetched sourcemaps', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				version: 3,
				sources: ['src/app.ts'],
				names: [],
				mappings: 'AAAA',
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			},
		)

	try {
		const resolved = await resolveSourcemappedLocation({
			file: 'http://127.0.0.1:3333/app.js',
			line: 1,
			column: 1,
		})
		expect(resolved).toEqual({ file: 'http://127.0.0.1:3333/src/app.ts', line: 1, column: 1 })
	} finally {
		globalThis.fetch = originalFetch
	}
})
