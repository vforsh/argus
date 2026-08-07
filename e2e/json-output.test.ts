import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const tempDirs: string[] = []

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('machine-safe JSON output', () => {
	test('routes plugin load chatter to stderr and leaves one JSON document on stdout', async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), 'argus-json-output-'))
		tempDirs.push(tempDir)
		const pluginPath = path.join(tempDir, 'noisy-plugin.mjs')
		await writeFile(
			pluginPath,
			`console.log('plugin load progress')
export default { apiVersion: 1, name: 'noisy', commands: [], register() {} }
`,
			'utf8',
		)

		const { stdout, stderr } = await runCommand('bun', [BIN_PATH, '--plugin', pluginPath, 'plugin', 'list', '--json'], {
			cwd: tempDir,
			env: { ...process.env, ARGUS_HOME: tempDir },
		})

		expect(JSON.parse(stdout)).toMatchObject({ entries: [{ name: 'noisy', status: 'loaded' }] })
		expect(stdout.trim().split('\n')).toHaveLength(1)
		expect(stderr).toContain('plugin load progress')
	})
})
