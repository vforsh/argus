/** Real Chromium + watcher probe. Build serially first; all state belongs to a temporary home/profile. */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { startSession } from '../e2e/helpers/session.ts'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = process.env.ARGUS_BENCH_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const moduleAt = (name) => import(pathToFileURL(path.join(root, name)).href)
const core = await moduleAt('packages/argus-core/dist/index.js')
const { startWatcher } = await moduleAt('packages/argus-watcher/dist/index.js')
const { resolveSelectorTargets } = await moduleAt('packages/argus-watcher/dist/cdp/dom/selector.js')
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-hot-paths-'))
process.env.ARGUS_HOME = dir
process.env.ARGUS_PLUGINS = ''
process.env.ARGUS_REGISTRY_PATH = path.join(dir, 'registry.json')
const registryPath = path.join(dir, 'discovery.json')
const now = Date.now()
await fs.writeFile(registryPath, JSON.stringify({ version: 1, updatedAt: now, watchers: {
	app: { id: 'app', host: '127.0.0.1', port: 1, pid: process.pid, startedAt: now, updatedAt: now },
} }))
const results = { node: process.version, samples: 30 }
const stats = (values) => {
	const sorted = [...values].sort((a, b) => a - b)
	return { p50: +sorted[Math.floor(sorted.length * .5)].toFixed(3), p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3) }
}
const bench = async (name, action, count = 30) => {
	const times = []
	for (let i = -3; i < count; i++) {
		const start = performance.now()
		await action()
		if (i >= 0) times.push(performance.now() - start)
	}
	results[name] = stats(times)
}
const server = http.createServer((req, res) => {
	if (req.url === '/slow.map') {
		setTimeout(() => res.end(JSON.stringify({ version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA' })), 250)
	} else if (req.url === '/bundle.js') {
		res.end('window.emit = text => console.log(text);\n//# sourceMappingURL=/slow.map')
	} else {
		res.setHeader('content-type', 'text/html')
		res.end(`<script src="/bundle.js"></script>${Array.from({ length: 1000 }, (_, i) => `<button>${i === 999 ? 'Needle' : 'Other'}</button>`).join('')}`)
	}
})
let browser, watcher, sessionProcess
try {
	const discovery = core.readActiveRegistry ?? core.readAndPruneRegistry
	const before = await fs.stat(registryPath)
	await bench('registry8', () => Promise.all(Array.from({ length: 8 }, () => discovery({ registryPath }))))
	results.registryUnchanged = (await fs.stat(registryPath)).mtimeMs === before.mtimeMs
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const origin = `http://127.0.0.1:${server.address().port}`
	const portServer = net.createServer()
	await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve))
	const port = portServer.address().port
	await new Promise((resolve) => portServer.close(resolve))
	browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] })
	results.chromium = browser.version()
	const page = await browser.newPage()
	await page.goto(origin)
	const cdp = await page.context().newCDPSession(page)
	let calls = [], payloadBytes = 0
	const session = {
		getReadyTargetContext: async () => ({ kind: 'page' }),
		sendAndWait: async (method, params) => {
			calls.push(method)
			const result = await cdp.send(method, params)
			payloadBytes += Buffer.byteLength(JSON.stringify({ method, params, result }))
			return result
		},
	}
	await bench('selector1000', async () => {
		calls = []; payloadBytes = 0
		const selected = await resolveSelectorTargets(session, { selector: 'button', text: 'Needle', all: true })
		if (selected.nodeIds.length !== 1) throw new Error('Selector must find exactly one button')
	})
	results.selectorCalls = calls.length
	results.selectorPayloadBytes = payloadBytes
	watcher = await startWatcher({ id: 'perf', chrome: { host: '127.0.0.1', port }, match: { url: origin },
		pageIndicator: { enabled: false }, pageConsoleLogging: 'none' })
	const endpoint = `http://127.0.0.1:${watcher.watcher.port}`
	const json = async (route, options) => (await fetch(endpoint + route, options)).json()
	while (!(await json('/status')).attached) await new Promise((resolve) => setTimeout(resolve, 10))
	await bench('httpDomInfo1000', async () => {
		const result = await json('/dom/info', { method: 'POST', body: JSON.stringify({ selector: 'button', text: 'Needle' }) })
		if (!result.ok || result.matches !== 1) throw new Error(JSON.stringify(result))
	})
	sessionProcess = startSession(path.join(root, 'packages/argus/dist/argus.js'), ['perf'], { env: process.env, cwd: dir })
	if ((await sessionProcess.next()).type !== 'ready') throw new Error('Session did not become ready')
	let requestId = 0
	await bench('sessionDomInfo1000', async () => {
		sessionProcess.send({ id: ++requestId, cmd: 'dom info', args: { selector: 'button', text: 'Needle' } })
		const reply = await sessionProcess.next()
		if (!reply.ok || reply.result?.matches !== 1) throw new Error(JSON.stringify(reply))
	})
	const rawTimes = [], finalTimes = []
	for (let i = -3; i < 30; i++) {
		await page.goto(origin + '/?sample=' + i) // A fresh document invalidates the map cache.
		const { cursor } = await json('/logs/cursor')
		const start = performance.now()
		const raw = json(`/tail?after=${cursor}&raw=1`).then((reply) => ({ reply, ms: performance.now() - start }))
		const final = json(`/tail?after=${cursor}`).then((reply) => ({ reply, ms: performance.now() - start }))
		await page.evaluate((i) => window.emit('sample-' + i), i)
		const [r, f] = await Promise.all([raw, final])
		if (r.reply.events[0]?.text !== 'sample-' + i || f.reply.events[0]?.text !== 'sample-' + i) throw new Error('Unexpected event')
		if (i >= 0) { rawTimes.push(r.ms); finalTimes.push(f.ms) }
	}
	results.coldMapRawAvailability = stats(rawTimes)
	results.coldMapFinalAvailability = stats(finalTimes)
	console.log(JSON.stringify(results, null, 2))
} finally {
	await sessionProcess?.close()
	await watcher?.close()
	await browser?.close()
	server.closeAllConnections()
	await new Promise((resolve) => server.close(resolve))
	await fs.rm(dir, { recursive: true, force: true })
}
