/** Run with Bun after a serial build. Stub transport isolates registry/discovery from browser work. */
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { startStubWatcher, evalJsonResponse } from '../e2e/helpers/stubWatcher.ts'
import { startSession } from '../e2e/helpers/session.ts'

const root = process.env.ARGUS_BENCH_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const core = await import(pathToFileURL(path.join(root, 'packages/argus-core/dist/index.js')).href)
const { createArgusClient } = await import(pathToFileURL(path.join(root, 'packages/argus-client/dist/index.js')).href)
const stub = await startStubWatcher({ 'POST /eval': evalJsonResponse(2) }, 'app')
const results = { bun: Bun.version, samples: 100 }
const bench = async (name, action, count = 100) => {
	const times = []
	for (let i = -5; i < count; i++) {
		const start = performance.now()
		await action()
		if (i >= 0) times.push(performance.now() - start)
	}
	times.sort((a, b) => a - b)
	results[name] = {
		p50: +times[Math.floor(times.length * .5)].toFixed(3),
		p95: +times[Math.ceil(times.length * .95) - 1].toFixed(3), samples: count,
	}
}
let session
try {
	const discovery = core.readActiveRegistry ?? core.readAndPruneRegistry
	await bench('registry8', () => Promise.all(Array.from({ length: 8 }, () => discovery({ registryPath: stub.registryPath }))), 30)
	const client = createArgusClient({ registryPath: stub.registryPath })
	const port = (await stub.readRegistry()).watchers.app.port
	const direct = async () => {
		const reply = await (await fetch(`http://127.0.0.1:${port}/eval`, { method: 'POST', body: '{}' })).json()
		return JSON.parse(reply.result).v
	}
	await bench('http', direct)
	await bench('sdk', () => client.evalValue('app', '1+1'))
	session = startSession(path.join(root, 'packages/argus/dist/argus.js'), ['app'], {
		env: { ...process.env, ARGUS_HOME: path.dirname(stub.registryPath), ARGUS_REGISTRY_PATH: stub.registryPath, ARGUS_PLUGINS: '' }, cwd: root,
	})
	if ((await session.next()).type !== 'ready') throw new Error('Session did not become ready')
	let id = 0
	const request = async () => {
		session.send({ id: ++id, cmd: 'eval', args: { expression: '1+1' } })
		const reply = await session.next()
		if (!reply.ok) throw new Error(JSON.stringify(reply))
	}
	await bench('session', request)
	const payload = Array.from({ length: 10_000 }, (_, i) => ({ id: i, url: 'https://example.test/item/' + i, text: 'x'.repeat(40) }))
	results.payloadBytes = Buffer.byteLength(JSON.stringify(payload))
	stub.setRoutes({ 'POST /eval': evalJsonResponse(payload) })
	await bench('httpLarge', direct, 30)
	await bench('sessionLarge', request, 30)
	console.log(JSON.stringify(results, null, 2))
} finally {
	await session?.close()
	await stub.close()
}
