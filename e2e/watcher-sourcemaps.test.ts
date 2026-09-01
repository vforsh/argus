import { test, expect } from 'bun:test'
import { createSourcemapResolver } from '@vforsh/argus-watcher/internal'
import { identityMap, inlineSourcemap, mockStaticFetch } from './helpers/staticFetch.js'

const annotate = (mapUrl: string): string => `console.log(1)\n//# sourceMappingURL=${mapUrl}\n`

test('resolves through the annotation a bundle carries', async () => {
	const { restore } = mockStaticFetch({
		'http://127.0.0.1:3333/app.js': annotate('app.js.map'),
		'http://127.0.0.1:3333/app.js.map': JSON.stringify(identityMap('src/app.ts')),
	})

	try {
		const resolved = await createSourcemapResolver().resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })
		expect(resolved).toEqual({ file: 'http://127.0.0.1:3333/src/app.ts', line: 1, column: 1 })
	} finally {
		restore()
	}
})

test('resolves a cache-busted bundle whose map is not at <script>.map', async () => {
	const { restore } = mockStaticFetch({
		'http://127.0.0.1:3333/app.js?v=abc123': annotate('/maps/app.a1b2.js.map'),
		'http://127.0.0.1:3333/maps/app.a1b2.js.map': JSON.stringify(identityMap('../src/app.ts')),
	})

	try {
		const resolved = await createSourcemapResolver().resolve({ file: 'http://127.0.0.1:3333/app.js?v=abc123', line: 1, column: 1 })
		expect(resolved).toEqual({ file: 'http://127.0.0.1:3333/src/app.ts', line: 1, column: 1 })
	} finally {
		restore()
	}
})

test('resolves an inline data: sourcemap', async () => {
	const { restore } = mockStaticFetch({
		'http://127.0.0.1:3333/app.js': annotate(inlineSourcemap(identityMap('src/app.ts'))),
	})

	try {
		const resolved = await createSourcemapResolver().resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })
		expect(resolved).toEqual({ file: 'http://127.0.0.1:3333/src/app.ts', line: 1, column: 1 })
	} finally {
		restore()
	}
})

test('returns null for a bundle with no annotation, and for a map that is not JSON', async () => {
	const { restore } = mockStaticFetch({
		'http://127.0.0.1:3333/bare.js': 'console.log(1)\n',
		'http://127.0.0.1:3333/lying.js': annotate('lying.js.map'),
		// The failure the old `${scriptUrl}.map` guess produced: 200 with JavaScript, not a map.
		'http://127.0.0.1:3333/lying.js.map': 'console.log(1)\n',
	})

	try {
		const resolver = createSourcemapResolver()
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/bare.js', line: 1, column: 1 })).toBeNull()
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/lying.js', line: 1, column: 1 })).toBeNull()
	} finally {
		restore()
	}
})

test('clear() lets a rebuilt bundle replace its cached map', async () => {
	const resolver = createSourcemapResolver()
	const first = mockStaticFetch({
		'http://127.0.0.1:3333/app.js': annotate('app.js.map'),
		'http://127.0.0.1:3333/app.js.map': JSON.stringify(identityMap('src/before.ts')),
	})

	try {
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })).toEqual({
			file: 'http://127.0.0.1:3333/src/before.ts',
			line: 1,
			column: 1,
		})
	} finally {
		first.restore()
	}

	const second = mockStaticFetch({
		'http://127.0.0.1:3333/app.js': annotate('app.js.map'),
		'http://127.0.0.1:3333/app.js.map': JSON.stringify(identityMap('src/after.ts')),
	})

	try {
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })).toEqual({
			file: 'http://127.0.0.1:3333/src/before.ts',
			line: 1,
			column: 1,
		})
		resolver.clear()
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })).toEqual({
			file: 'http://127.0.0.1:3333/src/after.ts',
			line: 1,
			column: 1,
		})
	} finally {
		second.restore()
	}
})

test('evicts past maxEntries instead of growing without bound', async () => {
	const { restore, requests } = mockStaticFetch({
		'http://127.0.0.1:3333/a.js': annotate(inlineSourcemap(identityMap('src/a.ts'))),
		'http://127.0.0.1:3333/b.js': annotate(inlineSourcemap(identityMap('src/b.ts'))),
	})

	try {
		const resolver = createSourcemapResolver({ maxEntries: 1 })
		const a = { file: 'http://127.0.0.1:3333/a.js', line: 1, column: 1 }
		await resolver.resolve(a)
		await resolver.resolve({ file: 'http://127.0.0.1:3333/b.js', line: 1, column: 1 })
		await resolver.resolve(a)

		// b.js pushed a.js out of a one-entry cache, so the third call had to refetch it.
		expect(requests.filter((request) => request.url.endsWith('/a.js'))).toHaveLength(2)
	} finally {
		restore()
	}
})

test('resolves against a server that rejects a suffix Range longer than the file', async () => {
	// Express / serve-static / range-parser answer 416 instead of clamping, so every script under
	// `tailBytes` used to resolve to null — sourcemaps silently off. See issue #9.
	const { restore, requests } = mockStaticFetch(
		{
			'http://127.0.0.1:3333/small.js': annotate('small.js.map'),
			'http://127.0.0.1:3333/small.js.map': JSON.stringify(identityMap('src/small.ts')),
		},
		{ ranges: 'reject-oversized-suffix' },
	)

	try {
		const resolved = await createSourcemapResolver().resolve({ file: 'http://127.0.0.1:3333/small.js', line: 1, column: 1 })
		expect(resolved).toEqual({ file: 'http://127.0.0.1:3333/src/small.ts', line: 1, column: 1 })
		expect(requests.filter((request) => request.url.endsWith('/small.js')).map((request) => request.range)).toEqual(['bytes=-65536', null])
	} finally {
		restore()
	}
})

test('resolves against a server that fails every ranged request without a 416', async () => {
	const { restore } = mockStaticFetch(
		{ 'http://127.0.0.1:3333/app.js': annotate(inlineSourcemap(identityMap('src/app.ts'))) },
		{ ranges: 'reject-all' },
	)

	try {
		const resolved = await createSourcemapResolver().resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })
		expect(resolved).toEqual({ file: 'http://127.0.0.1:3333/src/app.ts', line: 1, column: 1 })
	} finally {
		restore()
	}
})

test('stops sending Range to an origin that rejected one', async () => {
	// The dev server logs an error for every rejected range, so one per origin is the budget.
	const { restore, requests } = mockStaticFetch(
		{
			'http://127.0.0.1:3333/a.js': annotate(inlineSourcemap(identityMap('src/a.ts'))),
			'http://127.0.0.1:3333/b.js': annotate(inlineSourcemap(identityMap('src/b.ts'))),
			'http://127.0.0.1:3333/c.js': annotate(inlineSourcemap(identityMap('src/c.ts'))),
		},
		{ ranges: 'reject-oversized-suffix' },
	)

	try {
		const resolver = createSourcemapResolver()
		await resolver.resolve({ file: 'http://127.0.0.1:3333/a.js', line: 1, column: 1 })
		await resolver.resolve({ file: 'http://127.0.0.1:3333/b.js', line: 1, column: 1 })
		await resolver.resolve({ file: 'http://127.0.0.1:3333/c.js', line: 1, column: 1 })

		expect(requests.filter((request) => request.range !== null)).toHaveLength(1)
		expect(requests.map((request) => request.url)).toEqual([
			'http://127.0.0.1:3333/a.js',
			'http://127.0.0.1:3333/a.js',
			'http://127.0.0.1:3333/b.js',
			'http://127.0.0.1:3333/c.js',
		])
	} finally {
		restore()
	}
})

test('a range-honouring server keeps getting tail requests, and a 404 is not retried whole', async () => {
	const { restore, requests } = mockStaticFetch(
		{ 'http://127.0.0.1:3333/app.js': annotate(inlineSourcemap(identityMap('src/app.ts'))) },
		{ ranges: 'clamp' },
	)

	try {
		const resolver = createSourcemapResolver()
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/app.js', line: 1, column: 1 })).toEqual({
			file: 'http://127.0.0.1:3333/src/app.ts',
			line: 1,
			column: 1,
		})
		expect(await resolver.resolve({ file: 'http://127.0.0.1:3333/missing.js', line: 1, column: 1 })).toBeNull()

		expect(requests).toEqual([
			{ url: 'http://127.0.0.1:3333/app.js', range: 'bytes=-65536' },
			{ url: 'http://127.0.0.1:3333/missing.js', range: 'bytes=-65536' },
		])
	} finally {
		restore()
	}
})
