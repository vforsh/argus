/** The watcher's sourcemap resolver and ignore-list frame selection, against an in-memory fetch. */
import { describe, expect, test } from 'bun:test'
import { buildIgnoreMatcher, createSourcemapResolver, selectBestFrame } from '@vforsh/argus-watcher/internal'
import { identityMap, inlineSourcemap, withStaticFetch } from '../helpers/staticFetch.js'

const ORIGIN = 'http://127.0.0.1:3333'

/** A one-line bundle whose map lives at `mapUrl`. */
const annotate = (mapUrl: string): string => `console.log(1)\n//# sourceMappingURL=${mapUrl}\n`

/** Line 1, column 1 of `file` under ORIGIN: both what is resolved and what identity maps resolve to. */
const at = (file: string) => ({ file: `${ORIGIN}/${file}`, line: 1, column: 1 })

describe('sourcemap resolver', () => {
	test('resolves through the annotation a bundle carries', async () => {
		const files = { [`${ORIGIN}/app.js`]: annotate('app.js.map'), [`${ORIGIN}/app.js.map`]: JSON.stringify(identityMap('src/app.ts')) }
		await withStaticFetch(files, async () => {
			expect(await createSourcemapResolver().resolve(at('app.js'))).toEqual(at('src/app.ts'))
		})
	})

	test('resolves a cache-busted bundle whose map is not at <script>.map', async () => {
		const files = {
			[`${ORIGIN}/app.js?v=abc123`]: annotate('/maps/app.a1b2.js.map'),
			[`${ORIGIN}/maps/app.a1b2.js.map`]: JSON.stringify(identityMap('../src/app.ts')),
		}
		await withStaticFetch(files, async () => {
			expect(await createSourcemapResolver().resolve(at('app.js?v=abc123'))).toEqual(at('src/app.ts'))
		})
	})

	test('resolves an inline data: sourcemap', async () => {
		await withStaticFetch({ [`${ORIGIN}/app.js`]: annotate(inlineSourcemap(identityMap('src/app.ts'))) }, async () => {
			expect(await createSourcemapResolver().resolve(at('app.js'))).toEqual(at('src/app.ts'))
		})
	})

	test('returns null for a bundle with no annotation, and for a map that is not JSON', async () => {
		const files = {
			[`${ORIGIN}/bare.js`]: 'console.log(1)\n',
			[`${ORIGIN}/lying.js`]: annotate('lying.js.map'),
			// The failure the old `${scriptUrl}.map` guess produced: 200 with JavaScript, not a map.
			[`${ORIGIN}/lying.js.map`]: 'console.log(1)\n',
		}
		await withStaticFetch(files, async () => {
			const resolver = createSourcemapResolver()
			expect(await resolver.resolve(at('bare.js'))).toBeNull()
			expect(await resolver.resolve(at('lying.js'))).toBeNull()
		})
	})

	test('clear() lets a rebuilt bundle replace its cached map', async () => {
		const resolver = createSourcemapResolver()
		const build = (source: string) => ({ [`${ORIGIN}/app.js`]: annotate('app.js.map'), [`${ORIGIN}/app.js.map`]: JSON.stringify(identityMap(source)) })

		await withStaticFetch(build('src/before.ts'), async () => {
			expect(await resolver.resolve(at('app.js'))).toEqual(at('src/before.ts'))
		})

		await withStaticFetch(build('src/after.ts'), async () => {
			expect(await resolver.resolve(at('app.js'))).toEqual(at('src/before.ts'))
			resolver.clear()
			expect(await resolver.resolve(at('app.js'))).toEqual(at('src/after.ts'))
		})
	})

	test('evicts past maxEntries instead of growing without bound', async () => {
		const files = {
			[`${ORIGIN}/a.js`]: annotate(inlineSourcemap(identityMap('src/a.ts'))),
			[`${ORIGIN}/b.js`]: annotate(inlineSourcemap(identityMap('src/b.ts'))),
		}
		await withStaticFetch(files, async (requests) => {
			const resolver = createSourcemapResolver({ maxEntries: 1 })
			await resolver.resolve(at('a.js'))
			await resolver.resolve(at('b.js'))
			await resolver.resolve(at('a.js'))

			// b.js pushed a.js out of a one-entry cache, so the third call had to refetch it.
			expect(requests.filter((request) => request.url.endsWith('/a.js'))).toHaveLength(2)
		})
	})

	test('resolves against a server that rejects a suffix Range longer than the file', async () => {
		// Express / serve-static / range-parser answer 416 instead of clamping, so every script under
		// `tailBytes` used to resolve to null — sourcemaps silently off. See issue #9.
		const files = { [`${ORIGIN}/small.js`]: annotate('small.js.map'), [`${ORIGIN}/small.js.map`]: JSON.stringify(identityMap('src/small.ts')) }
		await withStaticFetch(
			files,
			async (requests) => {
				expect(await createSourcemapResolver().resolve(at('small.js'))).toEqual(at('src/small.ts'))
				expect(requests.filter((request) => request.url.endsWith('/small.js')).map((request) => request.range)).toEqual(['bytes=-65536', null])
			},
			{ ranges: 'reject-oversized-suffix' },
		)
	})

	test('resolves against a server that fails every ranged request without a 416', async () => {
		await withStaticFetch(
			{ [`${ORIGIN}/app.js`]: annotate(inlineSourcemap(identityMap('src/app.ts'))) },
			async () => {
				expect(await createSourcemapResolver().resolve(at('app.js'))).toEqual(at('src/app.ts'))
			},
			{ ranges: 'reject-all' },
		)
	})

	test('stops sending Range to an origin that rejected one', async () => {
		// The dev server logs an error for every rejected range, so one per origin is the budget.
		const files = Object.fromEntries(['a', 'b', 'c'].map((name) => [`${ORIGIN}/${name}.js`, annotate(inlineSourcemap(identityMap(`src/${name}.ts`)))]))
		await withStaticFetch(
			files,
			async (requests) => {
				const resolver = createSourcemapResolver()
				await resolver.resolve(at('a.js'))
				await resolver.resolve(at('b.js'))
				await resolver.resolve(at('c.js'))

				expect(requests.filter((request) => request.range !== null)).toHaveLength(1)
				expect(requests.map((request) => request.url)).toEqual([`${ORIGIN}/a.js`, `${ORIGIN}/a.js`, `${ORIGIN}/b.js`, `${ORIGIN}/c.js`])
			},
			{ ranges: 'reject-oversized-suffix' },
		)
	})

	test('a range-honouring server keeps getting tail requests, and a 404 is not retried whole', async () => {
		await withStaticFetch(
			{ [`${ORIGIN}/app.js`]: annotate(inlineSourcemap(identityMap('src/app.ts'))) },
			async (requests) => {
				const resolver = createSourcemapResolver()
				expect(await resolver.resolve(at('app.js'))).toEqual(at('src/app.ts'))
				expect(await resolver.resolve(at('missing.js'))).toBeNull()

				expect(requests).toEqual([
					{ url: `${ORIGIN}/app.js`, range: 'bytes=-65536' },
					{ url: `${ORIGIN}/missing.js`, range: 'bytes=-65536' },
				])
			},
			{ ranges: 'clamp' },
		)
	})
})

describe('ignore-list frame selection', () => {
	test('selectBestFrame skips ignored generated URL and picks next', async () => {
		const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['ignored'] })
		expect(ignoreMatcher).toBeTruthy()

		await withStaticFetch({}, async () => {
			const selected = await selectBestFrame(
				[
					{ url: 'http://localhost/ignored.js', lineNumber: 0, columnNumber: 0 },
					{ url: 'http://localhost/app.js', lineNumber: 4, columnNumber: 2 },
				],
				ignoreMatcher,
				createSourcemapResolver(),
			)

			expect(selected).toEqual({ file: 'http://localhost/app.js', line: 5, column: 3 })
		})
	})

	test('selectBestFrame skips when sourcemapped source is ignored', async () => {
		const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['node_modules'] })
		expect(ignoreMatcher).toBeTruthy()

		const files = {
			'http://localhost/first.js': annotate(inlineSourcemap(identityMap('webpack:///node_modules/ignored.ts'))),
			'http://localhost/second.js': annotate(inlineSourcemap(identityMap('src/app.ts'))),
		}
		await withStaticFetch(files, async () => {
			const selected = await selectBestFrame(
				[
					{ url: 'http://localhost/first.js', lineNumber: 0, columnNumber: 0 },
					{ url: 'http://localhost/second.js', lineNumber: 0, columnNumber: 0 },
				],
				ignoreMatcher,
				createSourcemapResolver(),
			)

			expect(selected).toEqual({ file: 'http://localhost/src/app.ts', line: 1, column: 1 })
		})
	})

	test('selectBestFrame returns null when all frames are ignored', async () => {
		const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['app.js'] })
		expect(ignoreMatcher).toBeTruthy()

		const selected = await selectBestFrame([{ url: 'http://localhost/app.js', lineNumber: 1, columnNumber: 2 }], ignoreMatcher, createSourcemapResolver())
		expect(selected).toBeNull()
	})

	test('buildIgnoreMatcher throws on invalid regex', () => {
		expect(() => buildIgnoreMatcher({ enabled: true, rules: ['['] })).toThrow(/Invalid ignoreList regex/)
	})
})
