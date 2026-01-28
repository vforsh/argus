import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { runCommand, runCommandWithExit } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const SCHEMA_PATH = path.resolve('packages/argus/schemas/argus.config.schema.json')
const EXPECTED_SCHEMA_REF = pathToFileURL(SCHEMA_PATH).href

test('config init creates default config', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-init-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	await runCommand('node', [BIN_PATH, 'config', 'init'], { cwd: tempDir })

	const configPath = path.join(tempDir, '.argus', 'config.json')
	const contents = await fs.readFile(configPath, 'utf8')
	const parsed = JSON.parse(contents) as { $schema?: string; chrome?: { start?: { url?: string } } }

	assert.equal(parsed.$schema, EXPECTED_SCHEMA_REF)
	assert.equal(parsed.chrome?.start?.url, 'http://localhost:3000')
})

test('config init errors when file exists without --force', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-init-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	await runCommand('node', [BIN_PATH, 'config', 'init'], { cwd: tempDir })

	const result = await runCommandWithExit('node', [BIN_PATH, 'config', 'init'], { cwd: tempDir })
	assert.equal(result.code, 2)
})

test('config init supports --path and --force', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-config-init-'))
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

	const targetPath = path.join(tempDir, 'argus.config.json')

	await runCommand('node', [BIN_PATH, 'config', 'init', '--path', targetPath], { cwd: tempDir })
	const first = await fs.readFile(targetPath, 'utf8')
	assert.ok(first.includes('"chrome"'))

	const result = await runCommandWithExit('node', [BIN_PATH, 'config', 'init', '--path', targetPath], { cwd: tempDir })
	assert.equal(result.code, 2)

	await runCommand('node', [BIN_PATH, 'config', 'init', '--path', targetPath, '--force'], { cwd: tempDir })
	const second = await fs.readFile(targetPath, 'utf8')
	assert.ok(second.includes('"watcher"'))
})
