import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bundleEvalEntry, type BundleEvalEntryResult } from '../packages/argus/src/commands/evalBundle.js'
import { fileUsesModuleSyntax } from '../packages/argus/src/commands/evalModuleSyntax.js'
import { resolveBundleDecision, resolveExpression } from '../packages/argus/src/commands/evalShared.js'
import type { Output } from '../packages/argus/src/output/io.js'

const tempDirs: string[] = []

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const createFixtureDir = async (): Promise<string> => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'argus-eval-bundle-'))
	tempDirs.push(dir)
	return dir
}

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

const runExpression = (source: string): unknown => {
	const runScript = globalThis['eval' as keyof typeof globalThis] as (code: string) => unknown
	return runScript(source)
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
		const root = await createFixtureDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 41\n',
			'main.js': 'import { value } from "./helper.js"\nvalue + 1\n',
		})

		const code = await expectBundleOk(root, 'main.js')
		expect(code).not.toMatch(/\bexport\b/)
		expect(code).not.toMatch(/\bimport\b/)
		expect(code).toContain('//# sourceURL=argus-file://')

		await expect(runExpression(code)).resolves.toBe(42)
	})

	test('supports TypeScript helpers and top-level await', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, {
			'helper.ts': 'export const value: number = 20\n',
			'main.ts': 'import { value } from "./helper.ts"\nawait Promise.resolve(value * 2)\n',
		})

		const code = await expectBundleOk(root, 'main.ts')
		expect(code).toContain('await Promise.resolve')
		expect(code).not.toMatch(/\bexport\b/)
	})

	test('inlines dynamic import of local files', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 41\n',
			'main.js': 'const module = await import("./helper.js")\nmodule.value + 1\n',
		})

		const code = await expectBundleOk(root, 'main.js')
		expect(code).not.toMatch(/\bexport\b/)
		expect(code).toContain('await')
	})

	test('rejects entry files that export bindings into the bundle', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, { 'main.js': 'export const value = 1\nvalue\n' })
		await expectBundleError(root, 'main.js', 'top-level export')
	})

	test('rejects node built-in imports', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, { 'main.js': 'import fs from "node:fs"\nfs\n' })
		await expectBundleError(root, 'main.js', 'Node built-in')
	})

	test('bundles imports outside the entry directory', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, {
			'outside/outside.js': 'export const value = 41\n',
			'entry/main.js': 'import { value } from "../outside/outside.js"\nvalue + 1\n',
		})

		const code = await expectBundleOk(root, 'entry/main.js')
		await expect(runExpression(code)).resolves.toBe(42)
	})

	test('bundles packages from node_modules', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, {
			'node_modules/pkg/package.json': '{"name":"pkg","type":"module","main":"index.js"}\n',
			'node_modules/pkg/index.js': 'export const value = 41\n',
			'sub/main.js': 'import { value } from "pkg"\nvalue + 1\n',
		})

		const previousCwd = process.cwd()
		process.chdir(root)
		try {
			const code = await expectBundleOk(root, 'sub/main.js')
			await expect(runExpression(code)).resolves.toBe(42)
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
		const root = await createFixtureDir()
		await writeFixture(root, {
			'helper.js': 'export const value = 41\n',
			'main.js': 'import { value } from "./helper.js"\nvalue + 1\n',
		})

		const output = createTestOutput()
		const resolved = await resolveExpression(undefined, { file: path.join(root, 'main.js') }, output)
		expect(resolved).not.toBeNull()
		expect(resolved).not.toMatch(/\bimport\b/)
		expect(output.warnings[0]).toContain('bundling automatically')
		await expect(runExpression(resolved!)).resolves.toBe(42)
	})

	test('--no-bundle reads file as-is', async () => {
		const root = await createFixtureDir()
		await writeFixture(root, { 'main.js': 'import { value } from "./helper.js"\n' })

		const output = createTestOutput()
		const resolved = await resolveExpression(undefined, { file: path.join(root, 'main.js'), noBundle: true }, output)
		expect(resolved).toContain('import { value }')
		expect(output.warnings).toHaveLength(0)
	})

	test('prepends inject after bundling', async () => {
		const root = await createFixtureDir()
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
