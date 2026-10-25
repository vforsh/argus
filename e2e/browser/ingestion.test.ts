import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Browser, Page } from 'playwright'
import { startWatcher, type WatcherHandle } from '@vforsh/argus-watcher'
import type { DomInfoResponse, ErrorResponse, LogsResponse, NetResponse, StatusResponse, TailResponse } from '@vforsh/argus-core'
import { createArgusClient } from '@vforsh/argus-client'
import { launchDebuggableBrowser } from '../helpers/browser.js'
import { waitFor } from '../helpers/poll.js'
import { startSite, type Site } from '../helpers/site.js'
import { makeTempDir, removeDir } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'
import { waitForWatcherPortAttached } from '../helpers/watcher.js'

setDefaultTimeout(TIMEOUTS.browser)

describe('buffer streams', () => {
	const until = <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => waitFor(read, ready, { timeoutMs: 5_000, intervalMs: 20 })

	for (const capacity of [0, 1, 3]) {
		test(`real watcher log/network streams wrap at capacity ${capacity}`, async () => {
			const dir = await makeTempDir('argus-buffer-stream')
			const oldHome = process.env.ARGUS_HOME
			process.env.ARGUS_HOME = dir
			const site = await startSite((req, res) => {
				res.setHeader('content-type', req.url === '/' ? 'text/html' : 'text/plain')
				res.end(req.url === '/' ? '<title>buffer-stream</title>' : `body:${req.url}`)
			})
			const { browser, debugPort } = await launchDebuggableBrowser()
			let watcher: WatcherHandle | undefined
			try {
				const page = await browser.newPage()
				await page.goto(`${site.origin}/`)
				watcher = await startWatcher({
					id: `buffer-${capacity}`, chrome: { host: '127.0.0.1', port: debugPort }, match: { title: 'buffer-stream' },
					bufferSize: capacity, net: { enabled: true }, pageConsoleLogging: 'none', pageIndicator: { enabled: false },
					artifacts: { base: dir },
				})
				const base = `http://127.0.0.1:${watcher.watcher.port}`
				const get = async <T>(url: string): Promise<T> => (await fetch(base + url)).json() as Promise<T>
				await until(() => get<StatusResponse>('/status'), (value) => value.attached)
				const epoch = (await get<{ epoch: string }>('/logs/epoch')).epoch
				await page.evaluate(() => { for (let index = 0; index < 10; index++) console.log(`ring-${index}`) })
				const stats = await until(() => get<StatusResponse>('/status'), (value) => capacity === 0 || (value.buffer.maxId ?? 0) >= 10)
				expect(stats.buffer.count).toBe(capacity)
				if (capacity > 0) expect(stats.buffer.maxId! - stats.buffer.minId! + 1).toBe(capacity)
				const logs = await get<LogsResponse>('/logs?limit=2&match=ring-')
				expect(logs.events.map((event) => event.text)).toEqual(Array.from({ length: Math.min(2, capacity) }, (_, i) => `ring-${10 - capacity + i}`))
				if (capacity === 3) {
					const next = await get<LogsResponse>(`/logs?after=${logs.nextCursor}&limit=2`)
					expect(next.events.map((event) => event.text)).toEqual(['ring-9'])
				}
				const stale = await until(() => get<{ error?: { code: string } }>(`/logs?after=${epoch}`), (value) => !!value.error)
				expect(stale.error?.code).toBe('log_epoch_evicted')
				const current = (await get<{ epoch: string }>('/logs/epoch')).epoch
				const prefix = 'argus-log-epoch-v1.'
				const payload = JSON.parse(Buffer.from(current.slice(prefix.length), 'base64url').toString())
				for (const [changes, code] of [[{ p: payload.p + 100 }, 'future'], [{ s: 'different-watcher' }, 'mismatch']] as const) {
					const cursor = prefix + Buffer.from(JSON.stringify({ ...payload, ...changes })).toString('base64url')
					expect((await get<{ error: { code: string } }>(`/logs?after=${cursor}`)).error.code).toBe(`log_epoch_${code}`)
				}
				expect((await get<{ error: { code: string } }>('/logs?after=bad')).error.code).toBe('log_epoch_invalid')
				const waiting = get<{ events?: unknown[]; error?: { code: string } }>(`/tail?after=${current}&levels=error&timeoutMs=1000`)
				await Bun.sleep(50)
				await page.evaluate(() => { for (let index = 0; index < 5; index++) console.log('nonmatching') })
				expect((await waiting).error?.code).toBe('log_epoch_evicted')

				await page.evaluate(async () => { for (let index = 0; index < 10; index++) await (await fetch(`/item-${index}`)).text() })
				const net = await until(() => get<NetResponse>('/net'), (value) => capacity === 0 || value.requests.at(-1)?.url.endsWith('/item-9') === true)
				expect(net.requests).toHaveLength(capacity)
				if (capacity === 0) return
				const latest = net.requests.at(-1)!
				const recent = await get<NetResponse>(`/net?after=${latest.id - 1}&limit=1`)
				expect(recent.requests.map((request) => request.id)).toEqual([latest.id])
				for (const lookup of [`id=${latest.id}`, `requestId=${latest.requestId}`]) {
					const body = await get<{ body: string }>(`/net/request/body?${lookup}`)
					expect(body.body).toBe('body:/item-9')
				}
				expect((await get<{ error: { code: string } }>(`/net/request?id=${latest.id - capacity}`)).error.code).toBe('not_found')
				await fetch(base + '/net/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
				expect((await get<NetResponse>('/net')).requests).toEqual([])
				expect((await get<{ error: { code: string } }>(`/net/request?requestId=${latest.requestId}`)).error.code).toBe('not_found')
				await page.evaluate(async () => { await (await fetch('/after-clear')).text() })
				const afterClear = await until(() => get<NetResponse>('/net'), (value) => value.requests.length > 0)
				expect(afterClear.requests[0]!.id).toBeGreaterThan(latest.id)
			} finally {
				await watcher?.close()
				await browser.close()
				await site.close()
				if (oldHome === undefined) delete process.env.ARGUS_HOME
				else process.env.ARGUS_HOME = oldHome
				await removeDir(dir)
			}
		})
	}
})

describe('watcher ingestion', () => {
	let browser: Browser
	let page: Page
	let watcher: WatcherHandle
	let site: Site
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
		dir = await makeTempDir('argus-ingestion')
		process.env.ARGUS_REGISTRY_PATH = path.join(dir, 'registry.json')
		site = await startSite((req, res) => {
			if (req.url?.endsWith('.map')) {
				mapRequests++
				activeMaps++
				maxActiveMaps = Math.max(maxActiveMaps, activeMaps)
				// Node emits `close` on the response when the client aborts; Bun's node:http only on the
				// request. Count whichever comes first, once, or an aborted map stays "active" forever.
				let open = true
				const settle = () => {
					if (open) activeMaps--
					open = false
				}
				res.on('close', settle)
				req.on('close', settle)
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
		origin = site.origin
		const debuggable = await launchDebuggableBrowser({ headless: true })
		browser = debuggable.browser
		const port = debuggable.debugPort
		page = await browser.newPage()
		await page.goto(origin)
		watcher = await startWatcher({
			id: 'ingestion', chrome: { host: '127.0.0.1', port }, match: { url: origin },
			pageIndicator: { enabled: false }, pageConsoleLogging: 'none', bufferSize: 2_000,
			artifacts: { base: dir, logs: { enabled: true, maxFiles: 100 } },
		})
		endpoint = `http://127.0.0.1:${watcher.watcher.port}`
		await waitForWatcherPortAttached(watcher.watcher.port)
	})

	afterAll(async () => {
		await watcher?.close()
		await browser?.close()
		await site?.close()
		if (oldRegistryPath === undefined) delete process.env.ARGUS_REGISTRY_PATH
		else process.env.ARGUS_REGISTRY_PATH = oldRegistryPath
		await removeDir(dir)
	})

	const get = async <T>(url: string): Promise<T> => (await (await fetch(endpoint + url)).json()) as T
	const epoch = async (): Promise<string> => (await get<{ cursor: string }>('/logs/cursor')).cursor
	const logs = (after: string, raw = false): Promise<LogsResponse> => get(`/logs?after=${after}&raw=${raw}&limit=2000`)
	const tail = (after: string, raw = false): Promise<TailResponse> => get(`/tail?after=${after}&raw=${raw}&timeoutMs=1000&limit=2000`)
	const emit = async (text: string): Promise<void> => { await page.evaluate((text) => (window as any).emit(text), text) }
	const resetPage = async (): Promise<void> => { await page.goto(origin + '/?n=' + Date.now()) }

	const until = <T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> => waitFor(read, check, { timeoutMs: 5_000, intervalMs: 10 })

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
	})

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
	})

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
})
