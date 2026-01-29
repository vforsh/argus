import { test, expect } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { runCommand, runCommandWithExit } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const SCHEMA_PATH = path.resolve('packages/argus/schemas/argus.config.schema.json')
const EXPECTED_SCHEMA_REF = pathToFileURL(SCHEMA_PATH).href

test('config init creates default config', async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-init-'))
	try {
		await runCommand('bun', [BIN_PATH, 'config', 'init'], { cwd: tempDir })

		const configPath = path.join(tempDir, '.argus', 'config.json')
		const contents = await fs.readFile(configPath, 'utf8')
		const parsed = JSON.parse(contents) as { $schema?: string; chrome?: { start?: { url?: string } } }

		expect(parsed.$schema).toBe(EXPECTED_SCHEMA_REF)
		expect(parsed.chrome?.start?.url).toBe('http://localhost:3000')
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config init errors when file exists without --force', async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-init-'))
	try {
		await runCommand('bun', [BIN_PATH, 'config', 'init'], { cwd: tempDir })

		const result = await runCommandWithExit('bun', [BIN_PATH, 'config', 'init'], { cwd: tempDir })
		expect(result.code).toBe(2)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})

test('config init supports --path and --force', async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-init-'))
	try {
		const targetPath = path.join(tempDir, 'argus.config.json')

		await runCommand('bun', [BIN_PATH, 'config', 'init', '--path', targetPath], { cwd: tempDir })
		const first = await fs.readFile(targetPath, 'utf8')
		expect(first).toContain('"chrome"')

		const result = await runCommandWithExit('bun', [BIN_PATH, 'config', 'init', '--path', targetPath], { cwd: tempDir })
		expect(result.code).toBe(2)

		await runCommand('bun', [BIN_PATH, 'config', 'init', '--path', targetPath, '--force'], { cwd: tempDir })
		const second = await fs.readFile(targetPath, 'utf8')
		expect(second).toContain('"watcher"')
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})
