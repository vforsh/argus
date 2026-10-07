import { expect, test } from 'bun:test'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { startWatcher, type WatcherHandle } from '@vforsh/argus-watcher'
import type { LogsResponse, NetResponse, StatusResponse } from '@vforsh/argus-core'
import { getFreePort } from './helpers/ports.js'

const until = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await read()
		if (ready(value)) return value
		await Bun.sleep(20)
	}
	throw new Error('Watcher did not receive expected CDP events')
}

for (const capacity of [0, 1, 3]) {
	test(`real watcher log/network streams wrap at capacity ${capacity}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-buffer-stream-'))
		const oldHome = process.env.ARGUS_HOME
		process.env.ARGUS_HOME = dir
		const server = http.createServer((req, res) => {
			res.setHeader('content-type', req.url === '/' ? 'text/html' : 'text/plain')
			res.end(req.url === '/' ? '<title>buffer-stream</title>' : `body:${req.url}`)
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const port = (server.address() as { port: number }).port
		const debugPort = await getFreePort()
		const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] })
		let watcher: WatcherHandle | undefined
		try {
			const page = await browser.newPage()
			await page.goto(`http://127.0.0.1:${port}/`)
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
			await new Promise<void>((resolve) => server.close(() => resolve()))
			if (oldHome === undefined) delete process.env.ARGUS_HOME
			else process.env.ARGUS_HOME = oldHome
			await fs.rm(dir, { recursive: true, force: true })
		}
	}, 30_000)
}
