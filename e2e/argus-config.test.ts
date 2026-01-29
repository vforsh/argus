import { test, expect } from 'bun:test'
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

test('resolveArgusConfigPath returns null when auto-discovery misses', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const resolved = resolveArgusConfigPath({ cwd: tempDir })
		expect(resolved).toBeNull()
		expect(process.exitCode).toBeUndefined()
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('resolveArgusConfigPath prefers .config/argus.json after .argus', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configDir = path.join(tempDir, '.config')
		await fs.mkdir(configDir, { recursive: true })

		const preferredPath = path.join(configDir, 'argus.json')
		const fallbackPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(preferredPath, JSON.stringify({ watcher: { start: { id: 'preferred' } } }))
		await fs.writeFile(fallbackPath, JSON.stringify({ watcher: { start: { id: 'fallback' } } }))

		const resolved = resolveArgusConfigPath({ cwd: tempDir })
		expect(resolved).toBe(preferredPath)
		expect(process.exitCode).toBeUndefined()
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('resolveArgusConfigPath errors on explicit missing path', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const resolved = resolveArgusConfigPath({ cwd: tempDir, cliPath: 'missing.json' })
		expect(resolved).toBeNull()
		expect(process.exitCode).toBe(2)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config pageIndicator=false is honored when CLI does not override', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ watcher: { start: { pageIndicator: false } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeTruthy()

		const merged = mergeWatcherStartOptionsWithConfig({ pageIndicator: true }, createCommand({}), configResult!)
		expect(merged).toBeTruthy()
		expect(merged!.pageIndicator).toBe(false)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('CLI overrides config when option source is cli', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ chrome: { start: { devTools: false } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeTruthy()

		const merged = mergeChromeStartOptionsWithConfig({ devTools: true }, createCommand({ devTools: 'cli' }), configResult!)
		expect(merged).toBeTruthy()
		expect(merged!.devTools).toBe(true)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config artifacts resolve relative to the config directory', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	const configDir = path.join(tempDir, '.argus')
	await fs.mkdir(configDir, { recursive: true })
	try {
		const configPath = path.join(configDir, 'config.json')
		await fs.writeFile(configPath, JSON.stringify({ watcher: { start: { artifacts: './artifacts' } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeTruthy()

		const merged = mergeWatcherStartOptionsWithConfig({}, createCommand({}), configResult!)
		expect(merged).toBeTruthy()
		expect(merged!.artifacts).toBe(path.resolve(configDir, 'artifacts'))
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config rejects chrome url and watcherId together', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ chrome: { start: { url: 'http://localhost', watcherId: 'app' } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeNull()
		expect(process.exitCode).toBe(2)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('merge rejects chrome url from CLI with watcherId from config', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ chrome: { start: { watcherId: 'app' } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeTruthy()

		const merged = mergeChromeStartOptionsWithConfig({ url: 'http://localhost' }, createCommand({ url: 'cli' }), configResult!)
		expect(merged).toBeNull()
		expect(process.exitCode).toBe(2)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config pageConsoleLogging is merged when CLI does not override', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ watcher: { start: { pageConsoleLogging: 'full' } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeTruthy()

		const merged = mergeWatcherStartOptionsWithConfig({}, createCommand({}), configResult!)
		expect(merged).toBeTruthy()
		expect(merged!.pageConsoleLogging).toBe('full')
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config rejects invalid pageConsoleLogging value', async () => {
	resetExitCode()
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-'))
	try {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ watcher: { start: { pageConsoleLogging: 'invalid' } } }))

		const configResult = loadArgusConfig(configPath)
		expect(configResult).toBeNull()
		expect(process.exitCode).toBe(2)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})
