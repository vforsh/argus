import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import {
	loadArgusConfig,
	mergeChromeStartOptionsWithConfig,
	mergeWatcherStartOptionsWithConfig,
	resolveArgusConfigPath,
} from '../packages/argus/src/config/argusConfig.js'

const resetExitCode = () => {
	process.exitCode = undefined
}

const createCommand = (sources: Record<string, string>) => ({
	getOptionValueSource: (key: string) => sources[key] ?? 'default',
})

test('resolveArgusConfigPath returns null when auto-discovery misses', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const resolved = resolveArgusConfigPath({ cwd: tempDir })
	assert.equal(resolved, null)
	assert.equal(process.exitCode, undefined)
})

test('resolveArgusConfigPath errors on explicit missing path', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const resolved = resolveArgusConfigPath({ cwd: tempDir, cliPath: 'missing.json' })
	assert.equal(resolved, null)
	assert.equal(process.exitCode, 2)
})

test('config pageIndicator=false is honored when CLI does not override', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const configPath = path.join(tempDir, 'argus.config.json')
	await fs.writeFile(configPath, JSON.stringify({ watcher: { start: { pageIndicator: false } } }))

	const configResult = loadArgusConfig(configPath)
	assert.ok(configResult)

	const merged = mergeWatcherStartOptionsWithConfig({ pageIndicator: true }, createCommand({}), configResult)
	assert.ok(merged)
	assert.equal(merged.pageIndicator, false)
})

test('CLI overrides config when option source is cli', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const configPath = path.join(tempDir, 'argus.config.json')
	await fs.writeFile(configPath, JSON.stringify({ chrome: { start: { devTools: false } } }))

	const configResult = loadArgusConfig(configPath)
	assert.ok(configResult)

	const merged = mergeChromeStartOptionsWithConfig({ devTools: true }, createCommand({ devTools: 'cli' }), configResult)
	assert.ok(merged)
	assert.equal(merged.devTools, true)
})

test('config artifacts resolve relative to the config directory', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	const configDir = path.join(tempDir, '.argus')
	await fs.mkdir(configDir, { recursive: true })
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const configPath = path.join(configDir, 'config.json')
	await fs.writeFile(configPath, JSON.stringify({ watcher: { start: { artifacts: './artifacts' } } }))

	const configResult = loadArgusConfig(configPath)
	assert.ok(configResult)

	const merged = mergeWatcherStartOptionsWithConfig({}, createCommand({}), configResult)
	assert.ok(merged)
	assert.equal(merged.artifacts, path.resolve(configDir, 'artifacts'))
})

test('config rejects chrome url and watcherId together', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const configPath = path.join(tempDir, 'argus.config.json')
	await fs.writeFile(configPath, JSON.stringify({ chrome: { start: { url: 'http://localhost', watcherId: 'app' } } }))

	const configResult = loadArgusConfig(configPath)
	assert.equal(configResult, null)
	assert.equal(process.exitCode, 2)
})

test('merge rejects chrome url from CLI with watcherId from config', async (t) => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const configPath = path.join(tempDir, 'argus.config.json')
	await fs.writeFile(configPath, JSON.stringify({ chrome: { start: { watcherId: 'app' } } }))

	const configResult = loadArgusConfig(configPath)
	assert.ok(configResult)

	const merged = mergeChromeStartOptionsWithConfig({ url: 'http://localhost' }, createCommand({ url: 'cli' }), configResult)
	assert.equal(merged, null)
	assert.equal(process.exitCode, 2)
})
