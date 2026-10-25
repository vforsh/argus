import { describe, test, expect, setDefaultTimeout } from 'bun:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { argusEnv, createCli } from '../helpers/cli.js'
import { REPO_ROOT } from '../helpers/paths.js'
import { useTempDirs } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.process)

describe('config init', () => {
	const SCHEMA_PATH = path.join(REPO_ROOT, 'packages', 'argus', 'schemas', 'argus.config.schema.json')
	const EXPECTED_SCHEMA_REF = pathToFileURL(SCHEMA_PATH).href
	const tempDir = useTempDirs('argus-config-init')

	// No ARGUS_HOME on purpose: `config init` writes into cwd, not the Argus home.
	const setup = async () => {
		const dir = await tempDir()
		return { dir, cli: createCli({ cwd: dir }) }
	}

	test('config init creates default config', async () => {
		const { dir, cli } = await setup()
		await cli.run(['config', 'init'])

		const configPath = path.join(dir, '.argus', 'config.json')
		const contents = await fs.readFile(configPath, 'utf8')
		const parsed = JSON.parse(contents) as { $schema?: string; chrome?: { start?: { url?: string } } }

		expect(parsed.$schema).toBe(EXPECTED_SCHEMA_REF)
		expect(parsed.chrome?.start?.url).toBe('http://localhost:3000')
	})

	test('config init errors when file exists without --force', async () => {
		const { cli } = await setup()
		await cli.run(['config', 'init'])

		const result = await cli.exec(['config', 'init'])
		expect(result.code).toBe(2)
	})

	test('config init supports --path and --force', async () => {
		const { dir, cli } = await setup()
		const targetPath = path.join(dir, 'argus.config.json')

		await cli.run(['config', 'init', '--path', targetPath])
		const first = await fs.readFile(targetPath, 'utf8')
		expect(first).toContain('"chrome"')

		const result = await cli.exec(['config', 'init', '--path', targetPath])
		expect(result.code).toBe(2)

		await cli.run(['config', 'init', '--path', targetPath, '--force'])
		const second = await fs.readFile(targetPath, 'utf8')
		expect(second).toContain('"watcher"')
	})
})

describe('plugin config', () => {
	const tempDir = useTempDirs('argus-plugin-config')

	/** CLI in a fresh project dir. Home defaults to `<dir>/home`; the global-config tests use the dir itself. */
	const setup = async ({ homeIsProject = false } = {}) => {
		const dir = await tempDir()
		return { dir, cli: createCli({ cwd: dir, env: argusEnv(homeIsProject ? dir : path.join(dir, 'home')) }) }
	}

	test('plugin add creates config and avoids duplicates', async () => {
		const { dir, cli } = await setup()
		await cli.run(['plugin', 'add', 'sample'])
		await cli.run(['plugin', 'add', 'sample'])

		const configPath = path.join(dir, '.argus', 'config.json')
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[] }
		expect(parsed.plugins).toEqual(['sample'])
	})

	test('plugin add supports explicit aliases', async () => {
		const { dir, cli } = await setup()
		await cli.run(['plugin', 'add', 'sample=./plugin.mjs'])

		const configPath = path.join(dir, '.argus', 'config.json')
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[]; pluginAliases?: Record<string, string> }
		expect(parsed.plugins).toEqual(['sample'])
		expect(parsed.pluginAliases).toEqual({ sample: './plugin.mjs' })
	})

	test('plugin add --global makes plugin commands available without --plugin', async () => {
		const { dir, cli } = await setup({ homeIsProject: true })
		const pluginPath = path.join(dir, 'plugin.mjs')
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

		await cli.run(['plugin', 'add', '--global', `sample=${pluginPath}`])

		const { stdout } = await cli.run(['sample'])
		const parsed = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as {
			plugins?: string[]
			pluginAliases?: Record<string, string>
		}
		expect(stdout.trim()).toBe('sample loaded')
		expect(parsed.plugins).toEqual(['sample'])
		expect(parsed.pluginAliases).toEqual({ sample: pluginPath })
	})

	test('plugin list reports global and local config plugins', async () => {
		const { dir, cli } = await setup({ homeIsProject: true })
		const globalPluginPath = path.join(dir, 'global.mjs')
		const localPluginPath = path.join(dir, 'local.mjs')
		await fs.writeFile(globalPluginPath, "export default { apiVersion: 1, name: 'global', commands: ['global'], register() {} }")
		await fs.writeFile(localPluginPath, "export default { apiVersion: 1, name: 'local', commands: ['local'], register() {} }")
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: ['global'], pluginAliases: { global: globalPluginPath } }))
		await fs.writeFile(path.join(dir, 'argus.config.json'), JSON.stringify({ plugins: ['local'], pluginAliases: { local: localPluginPath } }))

		const report = await cli.json<{
			entries: Array<{ status: string; name?: string; source?: string; spec?: string; resolvedSpec?: string }>
			globalConfigPath?: string | null
			configPath?: string | null
		}>(['plugin', 'list', '--json'])
		const realTempDir = await fs.realpath(dir)

		expect(report.globalConfigPath).toBe(path.join(dir, 'config.json'))
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

	test('plugin add avoids duplicate resolved aliases', async () => {
		const { dir, cli } = await setup()
		const configPath = path.join(dir, 'argus.config.json')
		await fs.writeFile(configPath, JSON.stringify({ plugins: ['@example/argus-plugin-sample'] }))

		await cli.run(['plugin', 'add', 'sample=@example/argus-plugin-sample'])

		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as { plugins?: string[]; pluginAliases?: Record<string, string> }
		expect(parsed.plugins).toEqual(['@example/argus-plugin-sample'])
		expect(parsed.pluginAliases).toEqual({ sample: '@example/argus-plugin-sample' })
	})

	test('plugin remove matches package shorthand and preserves unrelated config', async () => {
		const { dir, cli } = await setup()
		const configPath = path.join(dir, 'argus.config.json')
		await fs.writeFile(
			configPath,
			JSON.stringify({
				plugins: ['demo', './plugins/foo.js'],
				pluginAliases: { demo: '@example/argus-plugin-sample', foo: './plugins/foo.js' },
				chrome: { start: { url: 'http://localhost:3000' } },
			}),
		)

		await cli.run(['plugin', 'remove', 'sample'])

		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
			plugins?: string[]
			pluginAliases?: Record<string, string>
			chrome?: { start?: { url?: string } }
		}
		expect(parsed.plugins).toEqual(['./plugins/foo.js'])
		expect(parsed.pluginAliases).toEqual({ foo: './plugins/foo.js' })
		expect(parsed.chrome?.start?.url).toBe('http://localhost:3000')
	})

	test('plugin list reports metadata for loaded plugins', async () => {
		const { dir, cli } = await setup()
		const pluginPath = path.join(dir, 'plugin.mjs')
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

		const report = await cli.json<{
			entries: Array<{ status: string; name?: string; version?: string; description?: string; commands?: string[] }>
		}>(['--plugin', pluginPath, 'plugin', 'list', '--json'])
		expect(report.entries[0]).toMatchObject({
			status: 'loaded',
			name: 'sample',
			version: '1.2.3',
			description: 'Sample plugin',
			commands: ['sample', 'sp'],
		})
	})

	test('plugin list resolves configured aliases using local fixtures', async () => {
		const { dir, cli } = await setup()
		const pluginPath = path.join(dir, 'plugin.mjs')
		const configPath = path.join(dir, 'argus.config.json')
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
		await fs.writeFile(
			path.join(dir, 'alternate.mjs'),
			"export default { apiVersion: 1, name: 'alternate', commands: ['alternate'], register() {} }",
		)
		await fs.writeFile(configPath, JSON.stringify({ pluginAliases: { sample: './plugin.mjs', alternate: './alternate.mjs' } }))

		const report = await cli.json<{
			entries: Array<{ status: string; name?: string; spec?: string; resolvedSpec?: string; alias?: string | null }>
		}>(['--plugin', 'sample', '--plugin', 'alternate', 'plugin', 'list', '--json'])

		expect(report.entries).toHaveLength(2)
		expect(report.entries[0]).toMatchObject({ status: 'loaded', name: 'sample', spec: 'sample', resolvedSpec: './plugin.mjs', alias: 'sample' })
		expect(report.entries[1]).toMatchObject({
			status: 'loaded',
			name: 'alternate',
			spec: 'alternate',
			resolvedSpec: './alternate.mjs',
			alias: 'alternate',
		})
	})
})
