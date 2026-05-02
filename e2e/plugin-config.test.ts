import { test, expect } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { runCommand } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')

const withTempDir = async (fn: (tempDir: string) => Promise<void>): Promise<void> => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-plugin-config-'))
	try {
		await fn(tempDir)
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true })
	}
}

test('plugin add creates config and avoids duplicates', async () => {
	await withTempDir(async (tempDir) => {
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'gsheets'], { cwd: tempDir })
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'gsheets'], { cwd: tempDir })

		const configPath = path.join(tempDir, '.argus', 'config.json')
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[] }
		expect(parsed.plugins).toEqual(['gsheets'])
	})
})

test('plugin add supports explicit aliases', async () => {
	await withTempDir(async (tempDir) => {
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'sample=./plugin.mjs'], { cwd: tempDir })

		const configPath = path.join(tempDir, '.argus', 'config.json')
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[]; pluginAliases?: Record<string, string> }
		expect(parsed.plugins).toEqual(['sample'])
		expect(parsed.pluginAliases).toEqual({ sample: './plugin.mjs' })
	})
})

test('plugin add avoids duplicate resolved aliases', async () => {
	await withTempDir(async (tempDir) => {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ plugins: ['@vforsh/argus-plugin-google-sheets'] }))

		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'gsheets'], { cwd: tempDir })

		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[]; pluginAliases?: Record<string, string> }
		expect(parsed.plugins).toEqual(['@vforsh/argus-plugin-google-sheets'])
		expect(parsed.pluginAliases).toEqual({ gsheets: '@vforsh/argus-plugin-google-sheets' })
	})
})

test('plugin remove matches package shorthand and preserves unrelated config', async () => {
	await withTempDir(async (tempDir) => {
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(
			configPath,
			JSON.stringify({
				plugins: ['gsheets', './plugins/foo.js'],
				pluginAliases: { foo: './plugins/foo.js' },
				chrome: { start: { url: 'http://localhost:3000' } },
			}),
		)

		await runCommand('bun', [BIN_PATH, 'plugin', 'remove', 'google-sheets'], { cwd: tempDir })

		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
			plugins?: string[]
			pluginAliases?: Record<string, string>
			chrome?: { start?: { url?: string } }
		}
		expect(parsed.plugins).toEqual(['./plugins/foo.js'])
		expect(parsed.pluginAliases).toEqual({ foo: './plugins/foo.js' })
		expect(parsed.chrome?.start?.url).toBe('http://localhost:3000')
	})
})

test('plugin list reports metadata for loaded plugins', async () => {
	await withTempDir(async (tempDir) => {
		const pluginPath = path.join(tempDir, 'plugin.mjs')
		await fs.writeFile(
			pluginPath,
			`
export default {
	apiVersion: 1,
	name: 'sample',
	version: '1.2.3',
	description: 'Sample plugin',
	commands: ['sample', 'sp'],
	register() {},
}
`,
		)

		const { stdout } = await runCommand('bun', [BIN_PATH, '--plugin', pluginPath, 'plugin', 'list', '--json'], { cwd: tempDir })
		const report = JSON.parse(stdout) as {
			entries: Array<{ status: string; name?: string; version?: string; description?: string; commands?: string[] }>
		}
		expect(report.entries[0]).toMatchObject({
			status: 'loaded',
			name: 'sample',
			version: '1.2.3',
			description: 'Sample plugin',
			commands: ['sample', 'sp'],
		})
	})
})

test('plugin list resolves built-in and configured aliases', async () => {
	await withTempDir(async (tempDir) => {
		const pluginPath = path.join(tempDir, 'plugin.mjs')
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(
			pluginPath,
			`
export default {
	apiVersion: 1,
	name: 'sample',
	commands: ['sample'],
	register() {},
}
`,
		)
		await fs.writeFile(configPath, JSON.stringify({ pluginAliases: { sample: './plugin.mjs' } }))

		const { stdout } = await runCommand('bun', [BIN_PATH, '--plugin', 'sample', '--plugin', 'gs', 'plugin', 'list', '--json'], { cwd: tempDir })
		const report = JSON.parse(stdout) as {
			entries: Array<{ status: string; name?: string; spec?: string; resolvedSpec?: string; alias?: string | null }>
		}

		expect(report.entries).toHaveLength(2)
		expect(report.entries[0]).toMatchObject({ status: 'loaded', name: 'sample', spec: 'sample', resolvedSpec: './plugin.mjs', alias: 'sample' })
		expect(report.entries[1]).toMatchObject({
			status: 'loaded',
			name: 'google-sheets',
			spec: 'gs',
			resolvedSpec: '@vforsh/argus-plugin-google-sheets',
			alias: 'gs',
		})
	})
})
