import { afterAll, beforeAll, expect, test } from 'bun:test'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { startWatcher, type WatcherHandle } from '@vforsh/argus-watcher'
import type { DomInfoResponse, ErrorResponse, LogsResponse, TailResponse } from '@vforsh/argus-core'
import { createArgusClient } from '@vforsh/argus-client'
import { getFreePort } from './helpers/ports.js'
import { waitForWatcherPortAttached } from './helpers/watcher.js'

let browser: Browser
let page: Page
let watcher: WatcherHandle
let server: http.Server
let dir: string
let origin: string
let endpoint: string
let mapDelay = 250
let mapStatus = 200
let stallBody = false
let mapRequests = 0
let activeMaps = 0
let maxActiveMaps = 0
const oldRegistryPath = process.env.ARGUS_REGISTRY_PATH

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-ingestion-'))
	process.env.ARGUS_REGISTRY_PATH = path.join(dir, 'registry.json')
	server = http.createServer((req, res) => {
		if (req.url?.endsWith('.map')) {
			mapRequests++
			activeMaps++
			maxActiveMaps = Math.max(maxActiveMaps, activeMaps)
			res.on('close', () => activeMaps--)
			if (stallBody) {
				res.writeHead(200, { 'content-type': 'application/json' })
				res.write('{') // Headers arrive, but the body never finishes.
				return
			}
			if (mapDelay < 0) return // Deliberately stalled headers; aborted by navigation/deadline.
			setTimeout(() => {
				res.writeHead(mapStatus, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA' }))
			}, mapDelay)
			return
		}
		if (req.url?.startsWith('/bundle.js')) {
			res.end(`window.emit = text => console.log(text); window.boom = () => { throw new Error('mapped-boom') };\n//# sourceMappingURL=/slow.map`)
			return
		}
		res.setHeader('content-type', 'text/html')
		res.end(`<title>ingestion</title><script src="/bundle.js"></script><section>${Array.from({ length: 1000 }, (_, i) =>
			`<button id="b${i}">${i === 999 ? '  Needle  ' : 'Other'}</button>`).join('')}</section><div id="shadow"></div>`)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	const port = await getFreePort()
	browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] })
	page = await browser.newPage()
	await page.goto(origin)
	watcher = await startWatcher({
		id: 'ingestion', chrome: { host: '127.0.0.1', port }, match: { url: origin },
		pageIndicator: { enabled: false }, pageConsoleLogging: 'none', bufferSize: 2_000,
		artifacts: { base: dir, logs: { enabled: true, maxFiles: 100 } },
	})
	endpoint = `http://127.0.0.1:${watcher.watcher.port}`
	await waitForWatcherPortAttached(watcher.watcher.port)
}, 30_000)

afterAll(async () => {
	await watcher?.close()
	await browser?.close()
	server?.closeAllConnections()
	await new Promise<void>((resolve) => server?.close(() => resolve()))
	if (oldRegistryPath === undefined) delete process.env.ARGUS_REGISTRY_PATH
	else process.env.ARGUS_REGISTRY_PATH = oldRegistryPath
	await fs.rm(dir, { recursive: true, force: true })
})

const get = async <T>(url: string): Promise<T> => (await (await fetch(endpoint + url)).json()) as T
const epoch = async (): Promise<string> => (await get<{ cursor: string }>('/logs/cursor')).cursor
const logs = (after: string, raw = false): Promise<LogsResponse> => get(`/logs?after=${after}&raw=${raw}&limit=2000`)
const tail = (after: string, raw = false): Promise<TailResponse> => get(`/tail?after=${after}&raw=${raw}&timeoutMs=1000&limit=2000`)
const emit = async (text: string): Promise<void> => { await page.evaluate((text) => (window as any).emit(text), text) }
const resetPage = async (): Promise<void> => { await page.goto(origin + '/?n=' + Date.now()) }

const until = async <T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> => {
	const deadline = Date.now() + 5_000
	while (true) {
		const value = await read()
		if (check(value)) return value
		if (Date.now() > deadline) throw new Error(`Condition timed out: ${JSON.stringify(value)}`)
		await Bun.sleep(10)
	}
}

test('DOM text filtering preserves exact/regex order/count, refs and shadow boundaries despite page overrides', async () => {
	await page.evaluate(() => {
		document.querySelector('#shadow')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Needle</button>'
		Document.prototype.querySelectorAll = () => { throw new Error('main world query override') }
		Object.defineProperty(Node.prototype, 'textContent', { get: () => 'tampered', configurable: true })
		;(window as any).RegExp = () => { throw new Error('main world regex override') }
	})
	const info = async (text: string, all = false): Promise<DomInfoResponse> => (await (await fetch(endpoint + '/dom/info', {
		method: 'POST', body: JSON.stringify({ selector: 'button', text, all }),
	})).json()) as DomInfoResponse
	const exact = await info('Needle')
	expect(exact.matches).toBe(1)
	expect(exact.elements[0]?.attributes.id).toBe('b999')
	expect(exact.elements[0]?.ref).toBeDefined()
	const ref = await (await fetch(endpoint + '/dom/info', { method: 'POST', body: JSON.stringify({ ref: exact.elements[0]?.ref }) })).json()
	expect(ref).toMatchObject({ ok: true, matches: 1 })
	const regex = await info('/other/i', true)
	expect(regex.matches).toBe(999)
	expect(regex.elements[0]?.attributes.id).toBe('b0')
	expect(regex.elements.at(-1)?.attributes.id).toBe('b998')
	const ambiguous = await (await fetch(endpoint + '/dom/click', { method: 'POST', body: JSON.stringify({ selector: 'button', text: '/other/i' }) })).json() as ErrorResponse
	expect(ambiguous.error.code).toBe('multiple_matches')
	const invalid = await info('/[/') as unknown as ErrorResponse
	expect(invalid.ok).toBe(false)
	await resetPage()
})

test('slow cold maps never delay raw logs; final tail is ordered and immutable with identical ids', async () => {
	const mark = await epoch()
	const waitingRaw = tail(mark, true)
	const waitingFinal = tail(mark)
	await page.evaluate(() => { (window as any).emit('first-slow'); console.log('second-fast') })
	const raw = await waitingRaw
	expect(raw.events[0]?.text).toBe('first-slow')
	expect(raw.events[0]?.file).toContain('/bundle.js')
	const final = await waitingFinal
	expect(final.events[0]?.text).toBe('first-slow')
	expect(final.events[0]?.file).toContain('/original.ts')
	const all = await until(() => logs(mark), (result) => result.events.length === 2)
	expect(all.events.map((event) => event.text)).toEqual(['first-slow', 'second-fast'])
	expect(all.events[0]?.id).toBe(raw.events[0]?.id)
	expect((await logs(mark, true)).events[0]?.file).toContain('/bundle.js')
	expect((await logs(all.nextCursor)).events).toHaveLength(0)

	const client = createArgusClient({ registryPath: process.env.ARGUS_REGISTRY_PATH })
	const sdk = await client.logs('ingestion', { after: mark, raw: true, mode: 'full' })
	expect(sdk.events[0]?.file).toContain('/bundle.js')
})

test('stalled maps are bounded; navigation cancels old work before file rotation and epoch allocation', async () => {
	mapDelay = -1
	await resetPage()
	const mark = await epoch()
	await emit('before-navigation')
	await until(() => logs(mark, true), (result) => result.events.length === 1)
	await resetPage()
	mapDelay = 0
	await emit('after-navigation')
	const all = await until(() => logs(mark), (result) => result.events.length === 2)
	expect(all.events.map((event) => event.text)).toEqual(['before-navigation', 'after-navigation'])
	expect(all.events[0]?.enrichment).toBe('cancelled')
	expect(all.events[0]?.pageUrl).not.toBe(all.events[1]?.pageUrl)
	// A cold stalled load must be retried in the new generation, rather than poisoning it.
	expect(all.events[1]?.file).toContain('/original.ts')
	await until(async () => {
		const files = (await fs.readdir(path.join(dir, 'logs'))).sort()
		return Promise.all(files.map((name) => fs.readFile(path.join(dir, 'logs', name), 'utf8')))
	}, (contents) => contents.some((text) => text.includes('after-navigation')))
	const contents = await Promise.all((await fs.readdir(path.join(dir, 'logs'))).map((name) => fs.readFile(path.join(dir, 'logs', name), 'utf8')))
	expect(contents.filter((text) => text.includes('before-navigation'))).toHaveLength(1)
	expect(contents.filter((text) => text.includes('after-navigation'))).toHaveLength(1)
	expect(contents.find((text) => text.includes('before-navigation'))).not.toContain('after-navigation')
})

test('burst pressure finalizes previews in order, bounds map concurrency, and deadlines release stalled work', async () => {
	mapDelay = -1
	await resetPage()
	const mark = await epoch()
	const before = mapRequests
	maxActiveMaps = 0
	await page.evaluate(() => { for (let i = 0; i < 600; i++) (window as any).emit('burst-' + i) })
	const raw = await until(() => logs(mark, true), (result) => result.events.length === 600)
	expect(raw.events.map((event) => event.text)).toEqual(Array.from({ length: 600 }, (_, i) => 'burst-' + i))
	const final = await until(() => logs(mark), (result) => result.events.length === 600)
	expect(final.events.map((event) => event.id)).toEqual(raw.events.map((event) => event.id))
	expect(final.events.some((event) => event.enrichment === 'overloaded')).toBe(true)
	// The resolver may hit its own deadline before the queue's event deadline. Both finalize the generated view.
	expect(final.events.at(-1)?.file).toContain('/bundle.js')
	expect(mapRequests - before).toBeLessThanOrEqual(2)
	expect(maxActiveMaps).toBeLessThanOrEqual(2)
	await until(async () => activeMaps, (value) => value === 0)
}, 10_000)

test('distinct source burst cannot replace cancelled workers while response bodies remain stalled', async () => {
	mapDelay = 0
	stallBody = true
	try {
		await resetPage()
		await until(async () => activeMaps, (value) => value === 0)
		const mark = await epoch()
		const before = mapRequests
		maxActiveMaps = 0
		await page.evaluate((origin) => {
			for (let i = 0; i < 600; i++) {
				new Function(`console.log('unique-${i}')\n//# sourceURL=${origin}/bundle.js?unique=${i}`)()
			}
		}, origin)
		const raw = await until(() => logs(mark, true), (result) => result.events.length === 600)
		expect(mapRequests - before).toBeLessThanOrEqual(4)
		const final = await until(() => logs(mark), (result) => result.events.length === 600)
		expect(final.events.map((event) => event.id)).toEqual(raw.events.map((event) => event.id))
		expect(final.events.some((event) => event.enrichment === 'overloaded')).toBe(true)
		// A later wave may start after load deadlines; simultaneous physical requests stay bounded.
		expect(maxActiveMaps).toBeLessThanOrEqual(4)
		await until(async () => activeMaps, (value) => value === 0)
	} finally {
		stallBody = false
	}
}, 10_000)

test('failing maps keep generated locations and exception/remote-object serialization survives enrichment', async () => {
	mapDelay = 0
	mapStatus = 503
	await resetPage()
	const mark = await epoch()
	await page.evaluate(() => { (window as any).emit({ alpha: 1, nested: { beta: 2 } }); setTimeout(() => (window as any).boom(), 0) })
	const final = await until(() => logs(mark), (result) => result.events.some((event) => event.level === 'exception'))
	expect(final.events[0]?.args[0]).toMatchObject({ alpha: '1' })
	expect(final.events[0]?.file).toContain('/bundle.js')
	expect(final.events.find((event) => event.level === 'exception')?.text).toContain('mapped-boom')
	mapStatus = 200
})
