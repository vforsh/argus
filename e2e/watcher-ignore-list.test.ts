import { test, expect } from 'bun:test'
import { buildIgnoreMatcher, createSourcemapResolver, selectBestFrame } from '@vforsh/argus-watcher/internal'
import { identityMap, inlineSourcemap, mockStaticFetch } from './helpers/staticFetch.js'

const annotate = (mapUrl: string): string => `console.log(1)\n//# sourceMappingURL=${mapUrl}\n`

test('selectBestFrame skips ignored generated URL and picks next', async () => {
	const { restore } = mockStaticFetch({})
	const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['ignored'] })
	expect(ignoreMatcher).toBeTruthy()

	try {
		const selected = await selectBestFrame(
			[
				{ url: 'http://localhost/ignored.js', lineNumber: 0, columnNumber: 0 },
				{ url: 'http://localhost/app.js', lineNumber: 4, columnNumber: 2 },
			],
			ignoreMatcher,
			createSourcemapResolver(),
		)

		expect(selected).toEqual({ file: 'http://localhost/app.js', line: 5, column: 3 })
	} finally {
		restore()
	}
})

test('selectBestFrame skips when sourcemapped source is ignored', async () => {
	const { restore } = mockStaticFetch({
		'http://localhost/first.js': annotate(inlineSourcemap(identityMap('webpack:///node_modules/ignored.ts'))),
		'http://localhost/second.js': annotate(inlineSourcemap(identityMap('src/app.ts'))),
	})

	const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['node_modules'] })
	expect(ignoreMatcher).toBeTruthy()

	try {
		const selected = await selectBestFrame(
			[
				{ url: 'http://localhost/first.js', lineNumber: 0, columnNumber: 0 },
				{ url: 'http://localhost/second.js', lineNumber: 0, columnNumber: 0 },
			],
			ignoreMatcher,
			createSourcemapResolver(),
		)

		expect(selected).toEqual({ file: 'http://localhost/src/app.ts', line: 1, column: 1 })
	} finally {
		restore()
	}
})

test('selectBestFrame returns null when all frames are ignored', async () => {
	const ignoreMatcher = buildIgnoreMatcher({ enabled: true, rules: ['app.js'] })
	expect(ignoreMatcher).toBeTruthy()

	const selected = await selectBestFrame(
		[{ url: 'http://localhost/app.js', lineNumber: 1, columnNumber: 2 }],
		ignoreMatcher,
		createSourcemapResolver(),
	)
	expect(selected).toBeNull()
})

test('buildIgnoreMatcher throws on invalid regex', () => {
	expect(() => buildIgnoreMatcher({ enabled: true, rules: ['['] })).toThrow(/Invalid ignoreList regex/)
})
