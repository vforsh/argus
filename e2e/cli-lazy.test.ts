import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand, runCommandWithExit } from './helpers/process.js'
import { startSession } from './helpers/session.js'
import { startStubWatcher } from './helpers/stubWatcher.js'

const bins = ['bin.js', 'argus.js'].map((file) => path.resolve('packages/argus/dist', file))

const fixture = async (run: (dir: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-lazy-'))
	try {
		await run(dir, { ...process.env, ARGUS_HOME: dir, ARGUS_PLUGINS: '' })
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

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

for (const bin of bins) {
	for (const runtime of ['node', 'bun']) {
		test(`${runtime} ${path.basename(bin)} routes manifests without importing unrelated plugins`, async () => {
			await fixture(async (dir, env) => {
				const alpha = await plugin(dir, 'alpha')
				const beta = await plugin(dir, 'beta')
				await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [alpha, beta] }))
				await runCommand(runtime, [bin, 'list', '--json'], { cwd: dir, env })
				expect(await loaded(dir)).toEqual([])
				const result = await runCommand(runtime, [bin, 'alphaalias', 'app', '--value', 'hello', '--json'], { cwd: dir, env })
				expect(JSON.parse(result.stdout)).toEqual({ id: 'app', value: 'hello' })
				expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
				const help = await runCommand(runtime, [bin, 'beta', '--help'], { cwd: dir, env })
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
			const result = await runCommand('node', [bin, '--version'], { cwd: dir, env: { ...env, ARGUS_PLUGINS: legacy } })
			expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
			expect(result.stderr).toBe('')
		}
		expect(await loaded(dir)).toEqual([])
	})
})

test('root help and plugin list initialize all plugins, including legacy, in discovery order', async () => {
	await fixture(async (dir, env) => {
		const alpha = await plugin(dir, 'alpha')
		const beta = await plugin(dir, 'beta', false)
		const gamma = await plugin(dir, 'gamma')
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [alpha, beta, gamma] }))
		const help = await runCommand('node', [bins[1], '--help'], { cwd: dir, env })
		expect(help.stdout.indexOf('alpha|')).toBeLessThan(help.stdout.indexOf('beta|'))
		expect(help.stdout.indexOf('beta|')).toBeLessThan(help.stdout.indexOf('gamma|'))
		expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register', 'beta:import', 'beta:register', 'gamma:import', 'gamma:register'])
		const result = await runCommand('node', [bins[1], 'plugins', 'ls', '--json'], { cwd: dir, env })
		expect(JSON.parse(result.stdout).entries.map((entry: { name: string; status: string }) => [entry.name, entry.status]))
			.toEqual([['alpha', 'loaded'], ['beta', 'loaded'], ['gamma', 'loaded']])
	})
})

test('fresh package manifests and invalid sidecars cannot leave stale routing entries', async () => {
	await fixture(async (dir, env) => {
		const entry = await plugin(dir, 'alpha')
		await fs.rm(`${entry}.argus-plugin.json`)
		const packagePath = path.join(dir, 'package.json')
		const writeManifest = (commands: string[]) => fs.writeFile(packagePath, JSON.stringify({ argusPlugin: { apiVersion: 1, name: 'alpha', eager: false, commands } }))
		await writeManifest(['alpha', 'alphaalias'])
		await runCommand('node', [bins[1], '--plugin', entry, 'list', '--json'], { cwd: dir, env })
		expect(await loaded(dir)).toEqual([])
		await writeManifest(['alpha', 'alphaalias', 'other'])
		const unknown = await runCommandWithExit('node', [bins[1], '--plugin', entry, 'other'], { cwd: dir, env })
		expect(unknown.code).toBe(2)
		expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
		await fs.writeFile(`${entry}.argus-plugin.json`, '{ invalid')
		await runCommand('node', [bins[1], '--plugin', entry, 'list', '--json'], { cwd: dir, env })
		expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register', 'alpha:import', 'alpha:register'])
	})
})

test('env, config aliases, and CLI manifests share discovery without duplicate activation', async () => {
	await fixture(async (dir, env) => {
		const alpha = await plugin(dir, 'alpha')
		const beta = await plugin(dir, 'beta')
		await fs.writeFile(path.join(dir, 'argus.config.json'), JSON.stringify({ plugins: ['a'], pluginAliases: { a: alpha, b: beta } }))
		await runCommand('node', [bins[1], '--plugin=b', 'alpha', 'app', '--json'], { cwd: dir, env: { ...env, ARGUS_PLUGINS: 'a,b' } })
		expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
	})
})

test('sessions load plugin metadata on first request, reuse registration, and keep stdout as JSONL', async () => {
	const stub = await startStubWatcher({ 'GET /status': { payload: { ok: true, attached: true } } }, 'app')
	try {
		const dir = path.dirname(stub.registryPath)
		const alpha = await plugin(dir, 'alpha')
		const beta = await plugin(dir, 'beta')
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [alpha, beta] }))
		const session = startSession(bins[1], ['app'], { cwd: dir, env: { ...process.env, ARGUS_HOME: dir, ARGUS_PLUGINS: '' } })
		try {
			expect(await session.next()).toMatchObject({ type: 'ready' })
			expect(await loaded(dir)).toEqual([])
			for (const cmd of ['alphaalias', 'alpha']) {
				session.send({ cmd, args: { value: 'session' } })
				expect(await session.next()).toMatchObject({ ok: true, result: { id: 'app', value: 'session' } })
			}
			expect(await loaded(dir)).toEqual(['alpha:import', 'alpha:register'])
		} finally {
			await session.close()
		}
	} finally {
		await stub.close()
	}
})

test('bundled core help does not evaluate action chunks and packaged assets resolve beside chunks', async () => {
	await fixture(async (dir, env) => {
		const loader = path.join(dir, 'loader.mjs')
		await fs.writeFile(loader, `export async function load(url, context, next) {
			if (/\\/(domClick|watcherStart|eval|runSession)-[^/]+\\.js$/.test(url)) throw new Error('Eager action import: ' + url)
			return next(url, context)
		}`)
		await runCommand('node', ['--loader', loader, bins[1], '--help'], { cwd: dir, env })
		await runCommand('node', [bins[1], 'config', 'init'], { cwd: dir, env })
		const skill = await runCommand('node', [bins[1], 'skill', '--json'], { cwd: dir, env })
		const extension = await runCommand('node', [bins[1], 'extension', 'path', '--json'], { cwd: dir, env })
		await fs.access(JSON.parse(skill.stdout).path)
		await fs.access(path.join(JSON.parse(extension.stdout).path, 'manifest.json'))
	})
})


test('session watchdogs cannot register the same lazy plugin twice', async () => {
	const stub = await startStubWatcher({ 'GET /status': { payload: { ok: true, attached: true } } }, 'app')
	try {
		const dir = path.dirname(stub.registryPath)
		const entry = await plugin(dir, 'slow')
		const source = await fs.readFile(entry, 'utf8')
		await fs.writeFile(entry, source.replace('register({ program, host }) {',
			'async register({ program, host }) { await new Promise((resolve) => setTimeout(resolve, 150));'))
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ plugins: [entry] }))
		const session = startSession(bins[1], ['app'], { cwd: dir, env: { ...process.env, ARGUS_HOME: dir, ARGUS_PLUGINS: '' } })
		try {
			expect(await session.next()).toMatchObject({ type: 'ready' })
			session.send({ id: 1, cmd: 'slow', timeout: 40 })
			session.send({ id: 2, cmd: 'slow', timeout: 2000 })
			expect(await session.next()).toMatchObject({ id: 1, ok: false, error: { code: 'session_request_timeout' } })
			expect(await session.next()).toMatchObject({ id: 2, ok: true, result: { id: 'app', value: 'slow' } })
			expect(await loaded(dir)).toEqual(['slow:import', 'slow:register'])
		} finally {
			await session.close()
		}
	} finally {
		await stub.close()
	}
})
