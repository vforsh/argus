/** The `argus eval` CLI's in-process helpers: flag parsing, transport errors, args, `--out` sinks and `--file` bundling. */
import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HttpResponseError } from '@vforsh/argus-core'
import {
	bundleEvalEntry,
	createEvalResultFileSink,
	createOutput,
	fileUsesModuleSyntax,
	formatEvalTransportError,
	formatRotatedPath,
	loadEvalArgsFile,
	parseDurationFlagMs,
	parseEvalArgFlags,
	parseTimeoutMs,
	resolveBundleDecision,
	resolveEvalArgs,
	resolveExpression,
	wrapExpressionWithArgs,
	type BundleEvalEntryResult,
	type Output,
} from '@vforsh/argus/internal'
import { useTempDirs } from '../helpers/tempDir.js'

const makeTempDir = useTempDirs('argus-eval')

/** Indirect eval runs a generated script the way the page would, in global scope. */
const runScript = (source: string): unknown => (globalThis['eval' as keyof typeof globalThis] as (code: string) => unknown)(source)

describe('eval timeout parsing', () => {
	test('keeps bare eval timeout numbers as milliseconds', () => {
		expect(parseTimeoutMs('60000')).toEqual({ value: 60_000 })
		expect(parseTimeoutMs('250')).toEqual({ value: 250 })
	})

	test('accepts duration suffixes for eval timeout flags', () => {
		expect(parseTimeoutMs('60s')).toEqual({ value: 60_000 })
		expect(parseTimeoutMs('2m')).toEqual({ value: 120_000 })
		expect(parseTimeoutMs('1.5s')).toEqual({ value: 1_500 })
	})

	test('reports invalid timeout values with the flag name', () => {
		expect(parseDurationFlagMs('', '--timeout').error).toContain('Invalid --timeout value')
		expect(parseDurationFlagMs('soon', '--nav-timeout').error).toContain('Invalid --nav-timeout value')
	})
})

describe('eval client errors', () => {
	const watcher = { id: 'extension' }

	test('names watcher health before suggesting a longer eval timeout', () => {
		const message = formatEvalTransportError(watcher, new Error('Request timed out after 10000ms'), undefined)

		expect(message).toContain('extension: failed to reach watcher (Request timed out after 10000ms)')
		expect(message).toContain('argus watcher status extension')
		expect(message).toContain('pass a longer timeout as milliseconds or a duration')
		expect(message).toContain('argus eval extension --timeout 60s ...')
	})

	test('suggests increasing an explicitly configured timeout', () => {
		const message = formatEvalTransportError(watcher, new Error('Bridge request timed out after 60000ms'), 60_000)

		expect(message).toContain('argus eval extension --timeout 120s ...')
	})

	test('leaves the watcher’s own diagnosis alone', () => {
		// The watcher answered: its reply already names the layer that stalled, so the CLI must not
		// bolt "the watcher did not answer" onto it.
		const rejection = new HttpResponseError(
			'CDP request timed out after 10000ms. The page’s renderer did not answer a trivial evaluation within 2000ms',
			500,
		)

		const message = formatEvalTransportError(watcher, rejection, undefined)

		expect(message).toStartWith('extension: watcher rejected the request (')
		expect(message).not.toContain('pass a longer timeout')
	})

	test('keeps non-timeout transport errors concise', () => {
		const message = formatEvalTransportError(watcher, new Error('ECONNREFUSED'), undefined)

		expect(message).toBe('extension: failed to reach watcher (ECONNREFUSED)')
	})
})

describe('eval argument helpers', () => {
	test('parses key=value args as strings', () => {
		expect(parseEvalArgFlags(['level=10', 'debug=true'])).toEqual({
			value: { level: '10', debug: 'true' },
		})
	})

	test('keeps value text after the first equals sign', () => {
		expect(parseEvalArgFlags(['url=https://example.com?a=1&b=2', 'empty=']).value).toEqual({
			url: 'https://example.com?a=1&b=2',
			empty: '',
		})
	})

	test('rejects missing key or separator', () => {
		expect(parseEvalArgFlags(['level']).error).toBe('Invalid --arg value "level": expected key=value.')
		expect(parseEvalArgFlags(['=10']).error).toBe('Invalid --arg value "=10": expected key=value.')
		expect(parseEvalArgFlags(['']).error).toBe('Invalid --arg value "": expected key=value.')
	})

	test('uses the last duplicate key', () => {
		expect(parseEvalArgFlags(['level=1', 'level=2']).value).toEqual({ level: '2' })
	})

	test('loads args from JSON and coerces primitives to strings', async () => {
		const argsPath = path.join(await makeTempDir(), 'args.json')
		await writeFile(argsPath, JSON.stringify({ level: 10, debug: true, label: 'fast', empty: null }), 'utf8')

		const loaded = await loadEvalArgsFile(argsPath, createOutput({}))
		expect(loaded).toEqual({ level: '10', debug: 'true', label: 'fast', empty: 'null' })
	})

	test('merges --args file with --arg overrides', async () => {
		const argsPath = path.join(await makeTempDir(), 'args.json')
		await writeFile(argsPath, JSON.stringify({ level: '1', mode: 'slow' }), 'utf8')

		const merged = await resolveEvalArgs({ args: argsPath, arg: ['level=2', 'debug=true'] }, createOutput({}))
		expect(merged).toEqual({ level: '2', mode: 'slow', debug: 'true' })
	})

	test('leaves source unchanged with no args', () => {
		expect(wrapExpressionWithArgs('window.value', {})).toBe('window.value')
	})

	test('exposes frozen args without breaking bare expression completion values', () => {
		const source = wrapExpressionWithArgs('args.level', { level: '10' })

		expect(runScript(source)).toBe('10')
		expect(runScript(wrapExpressionWithArgs('Object.isFrozen(args)', { level: '10' }))).toBe(true)
	})
})

describe('eval result file output', () => {
	const sampleResponse = {
		ok: true as const,
		result: { count: 2 },
		type: 'object',
		exception: null,
	}

	test('writes pretty JSON for a single eval result', async () => {
		const outPath = path.join(await makeTempDir(), 'result.json')
		const sink = createEvalResultFileSink({ out: outPath, json: true })

		await sink?.write(sampleResponse, false)

		const content = await readFile(outPath, 'utf8')
		expect(JSON.parse(content)).toEqual(sampleResponse)
	})

	test('appends NDJSON lines while streaming', async () => {
		const outPath = path.join(await makeTempDir(), 'poll.ndjson')
		const sink = createEvalResultFileSink({ out: outPath, json: true })

		await sink?.write({ ...sampleResponse, result: 1 }, true)
		await sink?.write({ ...sampleResponse, result: 2 }, true)

		const lines = (await readFile(outPath, 'utf8')).trim().split('\n')
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0] ?? '').result).toBe(1)
		expect(JSON.parse(lines[1] ?? '').result).toBe(2)
	})

	test('rotates one file per poll iteration', async () => {
		const outPath = path.join(await makeTempDir(), 'frames.json')
		const sink = createEvalResultFileSink({ out: outPath, json: true, rotate: true })

		await sink?.write({ ...sampleResponse, result: 1 }, true)
		await sink?.write({ ...sampleResponse, result: 2 }, true)

		expect(JSON.parse(await readFile(formatRotatedPath(outPath, 1), 'utf8')).result).toBe(1)
		expect(JSON.parse(await readFile(formatRotatedPath(outPath, 2), 'utf8')).result).toBe(2)
	})

	test('formatRotatedPath inserts a counter before the extension', () => {
		expect(formatRotatedPath('/tmp/result.json', 3)).toBe(`${path.sep}tmp${path.sep}result.0003.json`)
	})
})

const writeFixture = async (root: string, files: Record<string, string>): Promise<void> => {
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(root, relativePath)
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, content, 'utf8')
	}
}

const bundleFile = (root: string, relativePath: string): Promise<BundleEvalEntryResult> => bundleEvalEntry(path.join(root, relativePath))

const expectBundleOk = async (root: string, relativePath: string): Promise<string> => {
	const result = await bundleFile(root, relativePath)
	expect(result.ok).toBe(true)
	if (!result.ok) {
		throw new Error(result.error)
	}
	return result.code
}

const expectBundleError = async (root: string, relativePath: string, needle: string | RegExp): Promise<void> => {
	const result = await bundleFile(root, relativePath)
	expect(result.ok).toBe(false)
	if (result.ok) {
		throw new Error('expected bundle to fail')
	}

	if (typeof needle === 'string') {
		expect(result.error).toContain(needle)
		return
	}

	expect(result.error).toMatch(needle)
}

const runScenarioExpression = (source: string, context: unknown): unknown => {
	const run = new Function('__argusScenarioContext', `return (${source}\n)`) as (scenarioContext: unknown) => unknown
	return run(context)
}

const createTestOutput = (): Output & { warnings: string[] } => {
	const warnings: string[] = []
	return {
		json: false,
		warnings,
		writeJson: () => {},
		writeJsonLine: () => {},
		writeHuman: () => {},
		writeWarn: (text: string) => {
			warnings.push(text)
		},
	}
}

describe('bundleEvalEntry', () => {
	test('bundles relative local imports', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 41\n',
			'main.js': 'import { value } from "./helper.js"\nvalue + 1\n',
		})

		const code = await expectBundleOk(root, 'main.js')
		expect(code).not.toMatch(/\nexport\s/)
		expect(code).not.toMatch(/\bimport\b/)
		expect(code).toContain('//# sourceURL=argus-file://')

		await expect(runScript(code)).resolves.toBe(42)
	})

	test('supports TypeScript helpers and top-level await', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'helper.ts': 'export const value: number = 20\n',
			'main.ts': 'import { value } from "./helper.ts"\nawait Promise.resolve(value * 2)\n',
		})

		const code = await expectBundleOk(root, 'main.ts')
		expect(code).toContain('await Promise.resolve')
		expect(code).not.toMatch(/\nexport\s/)
	})

	test('invokes a default-exported TypeScript scenario with context', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'main.ts': `
type Context = { args: Readonly<Record<string, string>> }
export default async function scenario(ctx: Context) {
	return { level: Number(ctx.args.level), ready: await Promise.resolve(true) }
}
`,
		})

		const code = await expectBundleOk(root, 'main.ts')
		await expect(runScenarioExpression(code, { args: { level: '12' } })).resolves.toEqual({ level: 12, ready: true })
	})

	test('inlines dynamic import of local files', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 41\n',
			'main.js': 'const module = await import("./helper.js")\nmodule.value + 1\n',
		})

		const code = await expectBundleOk(root, 'main.js')
		expect(code).not.toMatch(/\nexport\s/)
		expect(code).toContain('await')
	})

	test('allows named entry exports while preserving the final-expression compatibility path', async () => {
		const root = await makeTempDir()
		await writeFixture(root, { 'main.js': 'export const value = 1\nvalue\n' })
		const code = await expectBundleOk(root, 'main.js')
		await expect(runScript(code)).resolves.toBe(1)
	})

	test('rejects node built-in imports', async () => {
		const root = await makeTempDir()
		await writeFixture(root, { 'main.js': 'import fs from "node:fs"\nfs\n' })
		await expectBundleError(root, 'main.js', 'Node built-in')
	})

	test('bundles imports outside the entry directory', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'outside/outside.js': 'export const value = 41\n',
			'entry/main.js': 'import { value } from "../outside/outside.js"\nvalue + 1\n',
		})

		const code = await expectBundleOk(root, 'entry/main.js')
		await expect(runScript(code)).resolves.toBe(42)
	})

	test('bundles packages from node_modules', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'node_modules/pkg/package.json': '{"name":"pkg","type":"module","main":"index.js"}\n',
			'node_modules/pkg/index.js': 'export const value = 41\n',
			'sub/main.js': 'import { value } from "pkg"\nvalue + 1\n',
		})

		const previousCwd = process.cwd()
		process.chdir(root)
		try {
			const code = await expectBundleOk(root, 'sub/main.js')
			await expect(runScript(code)).resolves.toBe(42)
		} finally {
			process.chdir(previousCwd)
		}
	})
})

describe('fileUsesModuleSyntax', () => {
	test('detects leading import and export', () => {
		expect(fileUsesModuleSyntax('import x from "./x"\n')).toBe(true)
		expect(fileUsesModuleSyntax('export const x = 1\n')).toBe(true)
		expect(fileUsesModuleSyntax('// comment\nimport x from "./x"\n')).toBe(true)
		expect(fileUsesModuleSyntax('/* block */\nexport default 1\n')).toBe(true)
	})

	test('ignores import/export after other statements', () => {
		expect(fileUsesModuleSyntax('const x = 1\nimport "./x"\n')).toBe(false)
		expect(fileUsesModuleSyntax('console.log("import")\n')).toBe(false)
	})
})

describe('resolveBundleDecision', () => {
	test('--no-bundle wins over --bundle and auto-detect', () => {
		expect(resolveBundleDecision({ noBundle: true, bundle: true }, 'import x\n')).toEqual({
			shouldBundle: false,
			autoEnabled: false,
		})
	})

	test('--bundle forces bundling without auto flag', () => {
		expect(resolveBundleDecision({ bundle: true }, '1 + 1\n')).toEqual({
			shouldBundle: true,
			autoEnabled: false,
		})
	})

	test('auto-bundles when file uses module syntax', () => {
		expect(resolveBundleDecision({}, 'import x from "./x"\n')).toEqual({
			shouldBundle: true,
			autoEnabled: true,
		})
	})
})

describe('resolveExpression with --bundle', () => {
	test('requires --file for --bundle and --no-bundle', async () => {
		const output = createTestOutput()
		const resolved = await resolveExpression(undefined, { bundle: true }, output)
		expect(resolved).toBeNull()
		expect(output.warnings[0]).toContain('--bundle and --no-bundle require --file')

		const outputNoBundle = createTestOutput()
		const resolvedNoBundle = await resolveExpression(undefined, { noBundle: true }, outputNoBundle)
		expect(resolvedNoBundle).toBeNull()
		expect(outputNoBundle.warnings[0]).toContain('--bundle and --no-bundle require --file')
	})

	test('auto-bundles --file with import and warns', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 41\n',
			'main.js': 'import { value } from "./helper.js"\nvalue + 1\n',
		})

		const output = createTestOutput()
		const resolved = await resolveExpression(undefined, { file: path.join(root, 'main.js') }, output)
		expect(resolved).not.toBeNull()
		expect(resolved).not.toMatch(/\bimport\b/)
		expect(output.warnings[0]).toContain('bundling automatically')
		await expect(runScript(resolved!)).resolves.toBe(42)
	})

	test('--no-bundle reads file as-is', async () => {
		const root = await makeTempDir()
		await writeFixture(root, { 'main.js': 'import { value } from "./helper.js"\n' })

		const output = createTestOutput()
		const resolved = await resolveExpression(undefined, { file: path.join(root, 'main.js'), noBundle: true }, output)
		expect(resolved).toContain('import { value }')
		expect(output.warnings).toHaveLength(0)
	})

	test('prepends inject after bundling', async () => {
		const root = await makeTempDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 40\n',
			'main.js': 'import { value } from "./helper.js"\nvalue + 1\n',
			'inject.js': 'globalThis.__injected = 1\n',
		})

		const output = createTestOutput()
		const resolved = await resolveExpression(
			undefined,
			{ file: path.join(root, 'main.js'), bundle: true, inject: path.join(root, 'inject.js') },
			output,
		)
		expect(resolved).not.toBeNull()
		expect(resolved).toContain('globalThis.__injected = 1')
		expect(resolved).toContain('value + 1')
		expect(resolved).not.toMatch(/\bimport\b/)
	})
})
