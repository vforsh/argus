/** Run with Bun after a serial build. Compare real configured manifests with metadata-free legacy wrappers. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPluginManifest } from '../packages/argus/dist/cli/plugins/pluginManifest.js'
import { startStubWatcher, evalJsonResponse } from '../e2e/helpers/stubWatcher.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const cli = path.join(root, 'packages/argus/dist/argus.js')
const run = async (runtime, args, env) => {
	const child = Bun.spawn([runtime, cli, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	])
	if (code !== 0) throw new Error(stderr || stdout)
	return stdout
}
const entries = JSON.parse(await run('bun', ['plugin', 'list', '--json'], process.env)).entries.filter((entry) => entry.status === 'loaded')
if (!entries.length) throw new Error('No configured plugins')
for (const entry of entries) {
	const manifest = readPluginManifest(entry.url)
	if (!manifest || manifest.eager !== false || JSON.stringify([...manifest.commands].sort()) !== JSON.stringify([...entry.commands].sort())) {
		throw new Error(`Missing/incomplete independent manifest: ${entry.name}`)
	}
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-rollout-bench-'))
const stub = await startStubWatcher({ 'POST /eval': evalJsonResponse(2) }, 'app')
const results = { bun: Bun.version, samples: 30, plugins: entries.length, startup: {} }
try {
	for (const variant of ['legacy', 'actual']) {
		const home = path.join(dir, variant)
		await fs.mkdir(home)
		const plugins = []
		for (const [index, entry] of entries.entries()) {
			if (variant === 'actual') {
				plugins.push(entry.url)
				continue
			}
			const wrapper = path.join(home, `plugin-${index}.mjs`)
			await fs.writeFile(wrapper, `import * as mod from ${JSON.stringify(entry.url)}; export default mod.default ?? mod.argusPlugin`)
			plugins.push(wrapper)
		}
		await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ plugins }))
		const env = { ...process.env, ARGUS_HOME: home, ARGUS_REGISTRY_PATH: stub.registryPath, ARGUS_PLUGINS: '' }
		for (const runtime of ['node', 'bun']) {
			const times = []
			for (let i = -3; i < results.samples; i++) {
				const start = performance.now()
				await run(runtime, ['eval', 'app', '1+1', '--json'], env)
				if (i >= 0) times.push(performance.now() - start)
			}
			times.sort((a, b) => a - b)
			results.startup[`${runtime}/${variant}`] = {
				p50: +times[Math.floor(times.length * .5)].toFixed(3),
				p95: +times[Math.ceil(times.length * .95) - 1].toFixed(3),
			}
		}
	}
	console.log(JSON.stringify(results, null, 2))
} finally {
	await stub.close()
	await fs.rm(dir, { recursive: true, force: true })
}
