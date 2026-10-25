/** Config discovery, loading and CLI/config merge rules, in-process; exit-code paths run in a Node subprocess. */
import { beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PageConsoleLogging } from '@vforsh/argus-core'
import {
	loadArgusConfig,
	mergeChromeStartOptionsWithConfig,
	mergeWatcherStartOptionsWithConfig,
	resolveArgusConfigPath,
} from '@vforsh/argus/internal'
import { REPO_ROOT } from '../helpers/paths.js'
import { runCommandWithExit } from '../helpers/process.js'
import { useTempDirs } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.process)

const LOAD_CONFIG_MODULE_PATH = path.join(REPO_ROOT, 'packages/argus/dist/config/loadConfig.js')
const MERGE_CONFIG_MODULE_PATH = path.join(REPO_ROOT, 'packages/argus/dist/config/mergeConfig.js')

const makeTempDir = useTempDirs('argus-config')

// Rejections set `process.exitCode`; the in-process cases assert it stays unset.
beforeEach(() => {
	process.exitCode = undefined
})

const createCommand = (sources: Record<string, string>) => ({
	getOptionValueSource: (key: string) => sources[key] ?? 'default',
})

/** Write `config` as JSON at `relativePath` under `dir` and return its path. */
const writeConfig = async (dir: string, relativePath: string, config: unknown): Promise<string> => {
	const configPath = path.join(dir, relativePath)
	await fs.mkdir(path.dirname(configPath), { recursive: true })
	await fs.writeFile(configPath, JSON.stringify(config))
	return configPath
}

/** Load a config that must parse; every caller asserts that it did. */
const loadValidConfig = (configPath: string) => {
	const configResult = loadArgusConfig(configPath)
	expect(configResult).toBeTruthy()
	return configResult!
}

/**
 * Run `body` against the built modules in a Node subprocess and return what it printed plus the exit
 * code: rejections set `process.exitCode = 2`, which would leak into this test process.
 */
const runConfigSubprocess = async (body: string) => {
	const { stdout, code } = await runCommandWithExit('node', [
		'--input-type=module',
		'--eval',
		`
import { loadArgusConfig, resolveArgusConfigPath } from ${JSON.stringify(LOAD_CONFIG_MODULE_PATH)}
import { mergeChromeStartOptionsWithConfig } from ${JSON.stringify(MERGE_CONFIG_MODULE_PATH)}

const createCommand = (sources) => ({
	getOptionValueSource: (key) => sources[key] ?? 'default',
})

${body}
process.stdout.write(JSON.stringify({ result, exitCode: process.exitCode ?? null }))
`,
	])
	return { response: JSON.parse(stdout) as { result: unknown; exitCode: number | null }, code }
}

/** A rejected config yields no result, exit code 2 in-process, and process exit 2. */
const expectRejected = ({ response, code }: Awaited<ReturnType<typeof runConfigSubprocess>>): void => {
	expect(response.result).toBeNull()
	expect(response.exitCode).toBe(2)
	expect(code).toBe(2)
}

test('resolveArgusConfigPath returns null when auto-discovery misses', async () => {
	const resolved = resolveArgusConfigPath({ cwd: await makeTempDir() })
	expect(resolved).toBeNull()
	expect(process.exitCode).toBeUndefined()
})

test('resolveArgusConfigPath prefers .config/argus.json after .argus', async () => {
	const tempDir = await makeTempDir()
	const preferredPath = await writeConfig(tempDir, '.config/argus.json', { watcher: { start: { id: 'preferred' } } })
	await writeConfig(tempDir, 'argus.config.json', { watcher: { start: { id: 'fallback' } } })

	const resolved = resolveArgusConfigPath({ cwd: tempDir })
	expect(resolved).toBe(preferredPath)
	expect(process.exitCode).toBeUndefined()
})

test('resolveArgusConfigPath errors on explicit missing path', async () => {
	const tempDir = await makeTempDir()
	expectRejected(await runConfigSubprocess(`const result = resolveArgusConfigPath({ cwd: ${JSON.stringify(tempDir)}, cliPath: 'missing.json' })`))
})

test('config pageIndicator=false is honored when CLI does not override', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { watcher: { start: { pageIndicator: false } } })
	const configResult = loadValidConfig(configPath)

	const merged = mergeWatcherStartOptionsWithConfig<{ pageIndicator?: boolean }>({ pageIndicator: true }, createCommand({}), configResult)
	expect(merged).toBeTruthy()
	expect(merged!.pageIndicator).toBe(false)
})

test('CLI overrides config when option source is cli', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { chrome: { start: { devTools: false } } })
	const configResult = loadValidConfig(configPath)

	const merged = mergeChromeStartOptionsWithConfig({ devTools: true }, createCommand({ devTools: 'cli' }), configResult)
	expect(merged).toBeTruthy()
	expect(merged!.devTools).toBe(true)
})

test('config userAgent is merged and CLI can override it', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { chrome: { start: { userAgent: 'regular-chrome' } } })
	const configResult = loadValidConfig(configPath)

	expect(mergeChromeStartOptionsWithConfig<{ userAgent?: string }>({}, createCommand({}), configResult)?.userAgent).toBe('regular-chrome')
	expect(mergeChromeStartOptionsWithConfig({ userAgent: 'Literal/1.0' }, createCommand({ userAgent: 'cli' }), configResult)?.userAgent).toBe(
		'Literal/1.0',
	)
})

test('config artifacts resolve relative to the config directory', async () => {
	const configPath = await writeConfig(await makeTempDir(), '.argus/config.json', { watcher: { start: { artifacts: './artifacts' } } })
	const configResult = loadValidConfig(configPath)

	const merged = mergeWatcherStartOptionsWithConfig<{ artifacts?: string }>({}, createCommand({}), configResult)
	expect(merged).toBeTruthy()
	expect(merged!.artifacts).toBe(path.resolve(path.dirname(configPath), 'artifacts'))
})

test('config rejects chrome url and watcherId together', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { chrome: { start: { url: 'http://localhost', watcherId: 'app' } } })

	expectRejected(await runConfigSubprocess(`const result = loadArgusConfig(${JSON.stringify(configPath)})`))
})

test('merge rejects chrome url from CLI with watcherId from config', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { chrome: { start: { watcherId: 'app' } } })
	loadValidConfig(configPath)

	expectRejected(
		await runConfigSubprocess(`
const configResult = loadArgusConfig(${JSON.stringify(configPath)})
const result = mergeChromeStartOptionsWithConfig({ url: 'http://localhost' }, createCommand({ url: 'cli' }), configResult)
`),
	)
})

test('config pageConsoleLogging is merged when CLI does not override', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { watcher: { start: { pageConsoleLogging: 'full' } } })
	const configResult = loadValidConfig(configPath)

	const merged = mergeWatcherStartOptionsWithConfig<{ pageConsoleLogging?: PageConsoleLogging }>({}, createCommand({}), configResult)
	expect(merged).toBeTruthy()
	expect(merged!.pageConsoleLogging).toBe('full')
})

test('config rejects invalid pageConsoleLogging value', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { watcher: { start: { pageConsoleLogging: 'invalid' } } })

	expectRejected(await runConfigSubprocess(`const result = loadArgusConfig(${JSON.stringify(configPath)})`))
})

test('config loads plugin aliases', async () => {
	const configPath = await writeConfig(await makeTempDir(), 'argus.config.json', { plugins: ['sample'], pluginAliases: { sample: './plugin.mjs' } })
	const configResult = loadValidConfig(configPath)

	expect(configResult.config.pluginAliases).toEqual({ sample: './plugin.mjs' })
})
