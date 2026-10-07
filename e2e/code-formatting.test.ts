import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CodeResourceType } from '@vforsh/argus-core'
import { runCommand } from './helpers/process.js'
import { startStubWatcher, type StubWatcher } from './helpers/stubWatcher.js'

const fixtures: Record<string, { type: CodeResourceType; source: string; formatted?: string }> = {
	'script.js': { type: 'script', source: 'const needle={value:1}', formatted: 'const needle = { value: 1 };\n' },
	'style.css': { type: 'stylesheet', source: '.needle{color:red}', formatted: '.needle {\n  color: red;\n}\n' },
	'embedded.js': { type: 'script', source: 'const needle=css`a{color:red}`', formatted: 'const needle = css`\n  a {\n    color: red;\n  }\n`;\n' },
	'formatted.css': { type: 'stylesheet', source: '.needle {\n  color: red;\n}\n', formatted: '.needle {\n  color: red;\n}\n' },
	'broken.js': { type: 'script', source: 'const needle = {' },
	'broken.css': { type: 'stylesheet', source: '.needle{color:red' },
	'formatted.js': { type: 'script', source: 'const needle = 1;\n', formatted: 'const needle = 1;\n' },
}

const entries = [
	{ name: 'Node bundle', command: 'node', bin: 'packages/argus/dist/argus.js' },
	{ name: 'Node unbundled', command: 'node', bin: 'packages/argus/dist/bin.js' },
	{ name: 'Bun bundle', command: 'bun', bin: 'packages/argus/dist/argus.js' },
	{ name: 'Bun source', command: 'bun', bin: 'packages/argus/src/bin.ts' },
]

let watcher: StubWatcher
let tempDir: string
let loaderPath: string
let env: NodeJS.ProcessEnv

beforeAll(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-code-formatting-'))
	loaderPath = path.join(tempDir, 'trace-oxfmt.mjs')
	await writeFile(loaderPath, `export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'oxfmt' || specifier.startsWith('@oxfmt/')) {
		console.error('oxfmt-import:' + specifier)
		if (process.env.ARGUS_TEST_BLOCK_OXFMT === '1') throw new Error('Oxfmt unavailable for integration check')
	}
	if (specifier.startsWith('./bindings-') && process.env.ARGUS_TEST_BLOCK_BINDING === '1') throw new Error('Oxfmt native binding unavailable for integration check')
	if (specifier.includes('/prettier-')) console.error('vendored-prettier-import:' + specifier)
	return nextResolve(specifier, context)
}
`)
	watcher = await startStubWatcher({
		'POST /code/read': ({ body }) => {
			const fixture = fixtures[body.url as string]!
			const lines = fixture.source.split('\n')
			return { payload: {
				ok: true,
				resource: { url: body.url, type: fixture.type },
				source: fixture.source,
				content: fixture.source,
				totalLines: lines.length,
				startLine: 1,
				endLine: lines.length,
			} }
		},
		'POST /code/grep': () => ({ payload: {
			ok: true,
			matches: ['script.js', 'style.css'].map((url) => ({
				url, type: fixtures[url]!.type, lineNumber: 1, lineContent: fixtures[url]!.source,
			})),
			skippedResources: [],
		} }),
	})
	env = { ...process.env, ARGUS_HOME: tempDir, ARGUS_REGISTRY_PATH: watcher.registryPath }
})

afterAll(async () => {
	await watcher?.close()
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

for (const entry of entries) {
	describe(`runtime formatting: ${entry.name}`, () => {
		const runCli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => runCommand(entry.command, [
			...(entry.command === 'node' ? ['--no-warnings', '--experimental-loader', loaderPath] : []),
			path.resolve(entry.bin), ...args,
		], { env: { ...env, ...extraEnv }, cwd: tempDir })

		const importsFrom = (stderr: string): string[] => stderr.split('\n')
			.filter((line) => line.startsWith('oxfmt-import:')).map((line) => line.slice('oxfmt-import:'.length)).sort()

		test('unrelated commands do not load Oxfmt', async () => {
			const { stdout, stderr } = await runCli(['--version'], { ARGUS_TEST_BLOCK_OXFMT: '1' })
			expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
			expect(importsFrom(stderr)).toEqual([])
		})

		for (const [url, fixture] of Object.entries(fixtures)) {
			test(`deminify ${url} preserves formatting and fallback behavior`, async () => {
				const { stdout, stderr } = await runCli(['code', 'deminify', url, '--id', watcher.watcherId, '--json'])
				const response = JSON.parse(stdout)
				expect(response).toMatchObject({
					ok: true,
					resource: { url, type: fixture.type },
					source: fixture.formatted ?? fixture.source,
					changed: fixture.formatted !== undefined && fixture.formatted !== fixture.source,
				})
				if (fixture.formatted !== undefined) expect(response.formatError).toBeNull()
				else expect(response.formatError).toBeString()

				if (entry.command === 'node') {
					expect(importsFrom(stderr)).toContain('oxfmt')
					expect(stderr).not.toContain('vendored-prettier-import:')
				}
			})
		}

		test('grep --pretty shows JS/CSS context without loading Oxfmt', async () => {
			const { stdout, stderr } = await runCli([
				'code', 'grep', 'needle', '--id', watcher.watcherId, '--pretty',
			], { ARGUS_TEST_BLOCK_OXFMT: '1' })
			expect(stdout).toContain('const [[needle]]={value:1}')
			expect(stdout).toContain('.[[needle]]{color:red}')
			expect(importsFrom(stderr)).toEqual([])
		})

		if (entry.command !== 'node') return

		test('missing runtime formatter returns the original source and an error', async () => {
			const { stdout } = await runCli([
				'code', 'deminify', 'script.js', '--id', watcher.watcherId, '--json',
			], { ARGUS_TEST_BLOCK_OXFMT: '1' })
			expect(JSON.parse(stdout)).toMatchObject({
				ok: true, source: fixtures['script.js']!.source, changed: false,
				formatError: 'Oxfmt unavailable for integration check',
			})
		})

		test('missing native binding preserves JS/CSS source and reports the error', async () => {
			for (const url of ['script.js', 'style.css']) {
				const { stdout } = await runCli([
					'code', 'deminify', url, '--id', watcher.watcherId, '--json',
				], { ARGUS_TEST_BLOCK_BINDING: '1' })
				expect(JSON.parse(stdout)).toMatchObject({
					ok: true, source: fixtures[url]!.source, changed: false,
					formatError: 'Oxfmt native binding unavailable for integration check',
				})
			}
		})

		test('human output warns when formatting fails', async () => {
			const { stdout, stderr } = await runCli(['code', 'deminify', 'broken.js', '--id', watcher.watcherId])
			expect(stdout).toContain(fixtures['broken.js']!.source)
			expect(stderr).toContain('Formatter failed, showing original source:')
		})
	})
}
