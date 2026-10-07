import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { LogBuffer } from '../packages/argus-watcher/dist/buffer/LogBuffer.js'
import { NetBuffer } from '../packages/argus-watcher/dist/buffer/NetBuffer.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'argus-benchmark-'))
const cli = path.resolve(process.env.ARGUS_BENCH_CLI ?? 'packages/argus/dist/argus.js')
const manifestHome = path.join(home, 'manifests')
mkdirSync(manifestHome)
const samples = 30
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const result = { runtime: process.version, samples, capacity: 50_000, batch: 5_000, startup: {}, buffers: {} }
try {
	// Wrap configured modules only inside this temporary benchmark home. User plugins are untouched.
	const report = spawnSync('node', [cli, 'plugin', 'list', '--json'], { encoding: 'utf8' })
	if (report.status !== 0) throw new Error(report.stderr)
	const entries = JSON.parse(report.stdout).entries.filter((entry) => entry.status === 'loaded')
	const plugins = entries.map((entry, index) => {
		const wrapper = path.join(manifestHome, `plugin-${index}.mjs`)
		writeFileSync(wrapper, `import * as mod from ${JSON.stringify(entry.url)}; export default mod.default ?? mod.argusPlugin`)
		writeFileSync(`${wrapper}.argus-plugin.json`, JSON.stringify({ apiVersion: 1, name: entry.name, commands: entry.commands, eager: false }))
		return wrapper
	})
	writeFileSync(path.join(manifestHome, 'config.json'), JSON.stringify({ plugins }))
	result.pluginCount = plugins.length
	for (const runtime of ['node', 'bun']) {
		for (const variant of ['configured', 'empty', 'manifests']) {
			for (const args of [['--version'], ['list', '--json']]) {
				const env = { ...process.env, ...(variant === 'configured' ? {} : { ARGUS_HOME: variant === 'empty' ? home : manifestHome, ARGUS_PLUGINS: '' }) }
				const times = []
				for (let i = -3; i < samples; i++) {
					const start = performance.now()
					const child = spawnSync(runtime, [cli, ...args], { env, encoding: 'utf8' })
					if (child.status !== 0) throw new Error(child.stderr)
					if (i >= 0) times.push(performance.now() - start)
				}
				result.startup[`${runtime}/${variant}/${args[0]}`] = +median(times).toFixed(2)
			}
		}
	}
	const log = { ts: 1, level: 'log', text: 'event', args: [], file: null, line: null, column: null, pageUrl: null, pageTitle: null, source: 'console' }
	const summary = { requestId: 'req', ts: 1, method: 'GET', url: 'https://example.com', status: 200 }
	for (const [name, create, add, read] of process.env.ARGUS_BENCH_STARTUP_ONLY ? [] : [
		['logs', () => new LogBuffer(result.capacity), (b) => b.add(log), (b, id) => b.listAfter(id, {}, 10)],
		['net', () => new NetBuffer(result.capacity), (b) => b.add({ summary, detail: summary }), (b, id) => b.listAfter(id, {}, 10)],
	]) {
		const buffer = create()
		for (let i = 0; i < result.capacity; i++) add(buffer)
		const times = []
		for (let batch = 0; batch < 7; batch++) {
			const start = performance.now()
			for (let i = 0; i < result.batch; i++) add(buffer)
			times.push(performance.now() - start)
		}
		const cursor = buffer.getStats().maxId - 10
		const start = performance.now()
		for (let i = 0; i < 1_000; i++) read(buffer, cursor)
		result.buffers[name] = { fullAppendMedianMs: +median(times).toFixed(3), tail1000Ms: +(performance.now() - start).toFixed(3), batchesMs: times.map((t) => +t.toFixed(3)) }
	}
	console.log(JSON.stringify(result, null, 2))
} finally {
	rmSync(home, { recursive: true, force: true })
}
