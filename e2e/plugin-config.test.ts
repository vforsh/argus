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

const envFor = (tempDir: string): NodeJS.ProcessEnv => ({ ...process.env, ARGUS_HOME: path.join(tempDir, 'home') })

test('plugin add creates config and avoids duplicates', async () => {
	await withTempDir(async (tempDir) => {
		const env = envFor(tempDir)
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'gsheets'], { cwd: tempDir, env })
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'gsheets'], { cwd: tempDir, env })

		const configPath = path.join(tempDir, '.argus', 'config.json')
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[] }
		expect(parsed.plugins).toEqual(['gsheets'])
	})
})

test('plugin add supports explicit aliases', async () => {
	await withTempDir(async (tempDir) => {
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'sample=./plugin.mjs'], { cwd: tempDir, env: envFor(tempDir) })

		const configPath = path.join(tempDir, '.argus', 'config.json')
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[]; pluginAliases?: Record<string, string> }
		expect(parsed.plugins).toEqual(['sample'])
		expect(parsed.pluginAliases).toEqual({ sample: './plugin.mjs' })
	})
})

test('plugin add --global makes plugin commands available without --plugin', async () => {
	await withTempDir(async (tempDir) => {
		const pluginPath = path.join(tempDir, 'plugin.mjs')
		await fs.writeFile(
			pluginPath,
			`
export default {
	apiVersion: 1,
	name: 'sample',
	commands: ['sample'],
	register(ctx) {
		ctx.program.command('sample').action(() => {
			console.log('sample loaded')
		})
	},
}
`,
		)

		const env = { ...process.env, ARGUS_HOME: tempDir }
		await runCommand('bun', [BIN_PATH, 'plugin', 'add', '--global', `sample=${pluginPath}`], { cwd: tempDir, env })

		const { stdout } = await runCommand('bun', [BIN_PATH, 'sample'], { cwd: tempDir, env })
		const parsed = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8')) as {
			plugins?: string[]
			pluginAliases?: Record<string, string>
		}
		expect(stdout.trim()).toBe('sample loaded')
		expect(parsed.plugins).toEqual(['sample'])
		expect(parsed.pluginAliases).toEqual({ sample: pluginPath })
	})
})

test('plugin list reports global and local config plugins', async () => {
	await withTempDir(async (tempDir) => {
		const globalPluginPath = path.join(tempDir, 'global.mjs')
		const localPluginPath = path.join(tempDir, 'local.mjs')
		await fs.writeFile(globalPluginPath, "export default { apiVersion: 1, name: 'global', commands: ['global'], register() {} }")
		await fs.writeFile(localPluginPath, "export default { apiVersion: 1, name: 'local', commands: ['local'], register() {} }")
		await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify({ plugins: ['global'], pluginAliases: { global: globalPluginPath } }))
		await fs.writeFile(path.join(tempDir, 'argus.config.json'), JSON.stringify({ plugins: ['local'], pluginAliases: { local: localPluginPath } }))

		const { stdout } = await runCommand('bun', [BIN_PATH, 'plugin', 'list', '--json'], {
			cwd: tempDir,
			env: { ...process.env, ARGUS_HOME: tempDir },
		})
		const report = JSON.parse(stdout) as {
			entries: Array<{ status: string; name?: string; source?: string; spec?: string; resolvedSpec?: string }>
			globalConfigPath?: string | null
			configPath?: string | null
		}
		const realTempDir = await fs.realpath(tempDir)

		expect(report.globalConfigPath).toBe(path.join(tempDir, 'config.json'))
		expect(report.configPath).toBe(path.join(realTempDir, 'argus.config.json'))
		expect(report.entries).toHaveLength(2)
		expect(report.entries[0]).toMatchObject({
			status: 'loaded',
			name: 'global',
			source: 'global-config',
			spec: 'global',
			resolvedSpec: globalPluginPath,
		})
		expect(report.entries[1]).toMatchObject({ status: 'loaded', name: 'local', source: 'config', spec: 'local', resolvedSpec: localPluginPath })
	})
})

test('plugin add avoids duplicate resolved aliases', async () => {
	await withTempDir(async (tempDir) => {
		const env = envFor(tempDir)
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ plugins: ['@vforsh/argus-plugin-google-sheets'] }))

		await runCommand('bun', [BIN_PATH, 'plugin', 'add', 'gsheets'], { cwd: tempDir, env })

		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[]; pluginAliases?: Record<string, string> }
		expect(parsed.plugins).toEqual(['@vforsh/argus-plugin-google-sheets'])
		expect(parsed.pluginAliases).toEqual({ gsheets: '@vforsh/argus-plugin-google-sheets' })
	})
})

test('plugin remove matches package shorthand and preserves unrelated config', async () => {
	await withTempDir(async (tempDir) => {
		const env = envFor(tempDir)
		const configPath = path.join(tempDir, 'argus.config.json')
		await fs.writeFile(
			configPath,
			JSON.stringify({
				plugins: ['gsheets', './plugins/foo.js'],
				pluginAliases: { foo: './plugins/foo.js' },
				chrome: { start: { url: 'http://localhost:3000' } },
			}),
		)

		await runCommand('bun', [BIN_PATH, 'plugin', 'remove', 'google-sheets'], { cwd: tempDir, env })

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

		const { stdout } = await runCommand('bun', [BIN_PATH, '--plugin', pluginPath, 'plugin', 'list', '--json'], {
			cwd: tempDir,
			env: envFor(tempDir),
		})
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

		const { stdout } = await runCommand('bun', [BIN_PATH, '--plugin', 'sample', '--plugin', 'gs', 'plugin', 'list', '--json'], {
			cwd: tempDir,
			env: envFor(tempDir),
		})
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
