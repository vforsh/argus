import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { argusEnv, createCli } from '../helpers/cli.js'
import { useCleanup } from '../helpers/cleanup.js'
import { BIN_PATH, BUNDLE_PATH } from '../helpers/paths.js'
import { runCommand } from '../helpers/process.js'
import { startSession } from '../helpers/session.js'
import { startStubWatcher } from '../helpers/stubWatcher.js'
import { useTempDirs, withTempDir } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.process)

describe('lazy plugin loading', () => {
	// Both entries under both interpreters on purpose: the bundle's lazy chunks and the unbundled build route plugins differently.
	const bins = [BIN_PATH, BUNDLE_PATH]
	const defer = useCleanup()

	const fixture = (run: (dir: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> =>
		withTempDir('argus-lazy', (dir) => run(dir, argusEnv(dir, { ARGUS_PLUGINS: '' })))

	const plugin = async (dir: string, name: string, manifest = true): Promise<string> => {
		const entry = path.join(dir, `${name}.mjs`)
		await fs.writeFile(entry, `
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(path.join(dir, 'loaded'))}, '${name}:import\\n')
export default {
	apiVersion: 1, name: '${name}', commands: ['${name}', '${name}alias'],
	register({ program, host }) {
		appendFileSync(${JSON.stringify(path.join(dir, 'loaded'))}, '${name}:register\\n')
		program.command('${name}').alias('${name}alias').description('${name} description')
			.argument('[id]').option('--value <value>', 'Echo value').option('--json')
			.action((id, options) => host.createOutput(options).writeJson({ id, value: options.value ?? '${name}' }))
	},
}
`)
		if (manifest) await fs.writeFile(`${entry}.argus-plugin.json`, JSON.stringify({ apiVersion: 1, name, eager: false, commands: [name, `${name}alias`] }))
		return entry
	}

	const loaded = async (dir: string): Promise<string[]> => {
		try { return (await fs.readFile(path.join(dir, 'loaded'), 'utf8')).trim().split('\n') }
		catch { return [] }
	}

	/** Stub watcher `app` whose temp home doubles as the plugin dir; the session closes before the stub. */
	const startSessionFixture = async () => {
		const stub = await startStubWatcher({ 'GET /status': { payload: { ok: true, attached: true } } }, 'app')
		defer(() => stub.close())
		return stub.home
	}

	const openSession = (dir: string) => {
		const session = startSession(BUNDLE_PATH, ['app'], { cwd: dir, env: argusEnv(dir, { ARGUS_PLUGINS: '' }) })
		defer(() => session.close())
		return session
	}

	for (const bin of bins) {
		for (const runtime of ['node', 'bun'] as const) {
			test(`${runtime} ${path.basename(bin)} routes manifests without importing unrelated plugins`, async () => {
				await fixture(async (dir, env) => {
					const cli = createCli({ runtime, bin, cwd: dir, env })
					const alpha = await plugin(dir, 'alpha')
					const beta = await plugin(dir, 'beta')
					await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [alpha, beta] }))
					await cli.run(['list', '--json'])
					expect(await loaded(dir)).toEqual([])
					const result = await cli.run(['alphaalias', 'app', '--value', 'hello', '--json'])
					expect(JSON.parse(result.stdout)).toEqual({ id: 'app', value: 'hello' })
					expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
					const help = await cli.run(['beta', '--help'])
					expect(help.stdout).toContain('--value <value>')
					expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register', 'beta:import', 'beta:register'])
				})
			})
		}
	}

	test('version bypasses config errors and legacy plugin side effects', async () => {
		await fixture(async (dir, env) => {
			const legacy = await plugin(dir, 'legacy', false)
			await fs.writeFile(path.join(dir, 'config.json'), '{ broken json')
			for (const bin of bins) {
				const result = await createCli({ runtime: 'node', bin, cwd: dir, env: { ...env, ARGUS_PLUGINS: legacy } }).run(['--version'])
				expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
				expect(result.stderr).toBe('')
			}
			expect(await loaded(dir)).toEqual([])
		})
	})

	test('root help and plugin list initialize all plugins, including legacy, in discovery order', async () => {
		await fixture(async (dir, env) => {
			const cli = createCli({ runtime: 'node', bin: BUNDLE_PATH, cwd: dir, env })
			const alpha = await plugin(dir, 'alpha')
			const beta = await plugin(dir, 'beta', false)
			const gamma = await plugin(dir, 'gamma')
			await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [alpha, beta, gamma] }))
			const help = await cli.run(['--help'])
			expect(help.stdout.indexOf('alpha|')).toBeLessThan(help.stdout.indexOf('beta|'))
			expect(help.stdout.indexOf('beta|')).toBeLessThan(help.stdout.indexOf('gamma|'))
			expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register', 'beta:import', 'beta:register', 'gamma:import', 'gamma:register'])
			const result = await cli.run(['plugins', 'ls', '--json'])
			expect(JSON.parse(result.stdout).entries.map((entry: { name: string; status: string }) => [entry.name, entry.status]))
				.toEqual([['alpha', 'loaded'], ['beta', 'loaded'], ['gamma', 'loaded']])
		})
	})

	test('fresh package manifests and invalid sidecars cannot leave stale routing entries', async () => {
		await fixture(async (dir, env) => {
			const cli = createCli({ runtime: 'node', bin: BUNDLE_PATH, cwd: dir, env })
			const entry = await plugin(dir, 'alpha')
			await fs.rm(`${entry}.argus-plugin.json`)
			const packagePath = path.join(dir, 'package.json')
			const writeManifest = (commands: string[]) => fs.writeFile(packagePath, JSON.stringify({ argusPlugin: { apiVersion: 1, name: 'alpha', eager: false, commands } }))
			await writeManifest(['alpha', 'alphaalias'])
			await cli.run(['--plugin', entry, 'list', '--json'])
			expect(await loaded(dir)).toEqual([])
			await writeManifest(['alpha', 'alphaalias', 'other'])
			const unknown = await cli.exec(['--plugin', entry, 'other'])
			expect(unknown.code).toBe(2)
			expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
			await fs.writeFile(`${entry}.argus-plugin.json`, '{ invalid')
			await cli.run(['--plugin', entry, 'list', '--json'])
			expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register', 'alpha:import', 'alpha:register'])
		})
	})

	test('env, config aliases, and CLI manifests share discovery without duplicate activation', async () => {
		await fixture(async (dir, env) => {
			const alpha = await plugin(dir, 'alpha')
			const beta = await plugin(dir, 'beta')
			await fs.writeFile(path.join(dir, 'argus.config.json'), JSON.stringify({ plugins: ['a'], pluginAliases: { a: alpha, b: beta } }))
			await createCli({ runtime: 'node', bin: BUNDLE_PATH, cwd: dir, env: { ...env, ARGUS_PLUGINS: 'a,b' } }).run(['--plugin=b', 'alpha', 'app', '--json'])
			expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
		})
	})

	test('sessions load plugin metadata on first request, reuse registration, and keep stdout as JSONL', async () => {
		const dir = await startSessionFixture()
		const alpha = await plugin(dir, 'alpha')
		const beta = await plugin(dir, 'beta')
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [alpha, beta] }))
		const session = openSession(dir)
		expect(await session.next()).toMatchObject({ type: 'ready' })
		expect(await loaded(dir)).toEqual([])
		for (const cmd of ['alphaalias', 'alpha']) {
			session.send({ cmd, args: { value: 'session' } })
			expect(await session.next()).toMatchObject({ ok: true, result: { id: 'app', value: 'session' } })
		}
		expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
	})

	test('bundled core help does not evaluate action chunks and packaged assets resolve beside chunks', async () => {
		await fixture(async (dir, env) => {
			const cli = createCli({ runtime: 'node', bin: BUNDLE_PATH, cwd: dir, env })
			const loader = path.join(dir, 'loader.mjs')
			await fs.writeFile(loader, `export async function load(url, context, next) {
			if (/\\/(domClick|watcherStart|eval|runSession)-[^/]+\\.js$/.test(url)) throw new Error('Eager action import: ' + url)
			return next(url, context)
		}`)
			// The loader flag must precede the entry, so this one call bypasses `createCli`.
			await runCommand('node', ['--loader', loader, BUNDLE_PATH, '--help'], { cwd: dir, env })
			await cli.run(['config', 'init'])
			const skill = await cli.run(['skill', '--json'])
			const extension = await cli.run(['extension', 'path', '--json'])
			await fs.access(JSON.parse(skill.stdout).path)
			await fs.access(path.join(JSON.parse(extension.stdout).path, 'manifest.json'))
		})
	})

	test('session watchdogs cannot register the same lazy plugin twice', async () => {
		const dir = await startSessionFixture()
		const entry = await plugin(dir, 'slow')
		const source = await fs.readFile(entry, 'utf8')
		await fs.writeFile(entry, source.replace('register({ program, host }) {',
			'async register({ program, host }) { await new Promise((resolve) => setTimeout(resolve, 150));'))
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [entry] }))
		const session = openSession(dir)
		expect(await session.next()).toMatchObject({ type: 'ready' })
		session.send({ id: 1, cmd: 'slow', timeout: 40 })
		session.send({ id: 2, cmd: 'slow', timeout: 2000 })
		expect(await session.next()).toMatchObject({ id: 1, ok: false, error: { code: 'session_request_timeout' } })
		expect(await session.next()).toMatchObject({ id: 2, ok: true, result: { id: 'app', value: 'slow' } })
		expect(await loaded(dir)).toEqual(['slow:import', 'slow:register'])
	})
})

describe('machine-safe JSON output', () => {
	const tempDir = useTempDirs('argus-json-output')

	test('routes plugin load chatter to stderr and leaves one JSON document on stdout', async () => {
		const dir = await tempDir()
		const pluginPath = path.join(dir, 'noisy-plugin.mjs')
		await fs.writeFile(
			pluginPath,
			`console.log('plugin load progress')
export default { apiVersion: 1, name: 'noisy', commands: [], register() {} }
`,
			'utf8',
		)

		const { stdout, stderr } = await createCli({ cwd: dir, env: argusEnv(dir) }).run(['--plugin', pluginPath, 'plugin', 'list', '--json'])

		expect(JSON.parse(stdout)).toMatchObject({ entries: [{ name: 'noisy', status: 'loaded' }] })
		expect(stdout.trim().split('\n')).toHaveLength(1)
		expect(stderr).toContain('plugin load progress')
	})
})
