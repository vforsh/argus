import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { DomClickResponse, ErrorResponse, EvalResponse, NavigateHistoryResponse, NavigateResponse, StatusResponse } from '@vforsh/argus-core'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import { startSite, type Site } from '../helpers/site.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

/** How long `/slow` withholds its blocking subresource, so `load` lands well after DOMContentLoaded. */
const SLOW_LOAD_MS = 1_500

const page = (title: string, body: string): string =>
	`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}<script>console.log('loaded:${title}')</script></body></html>`

/** Fixture site: two linked pages, one that loads slowly, and one that redirects. */
const createSite = (): Promise<Site> =>
	startSite((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')

		if (url.pathname === '/slow-image') {
			// Held open past DOMContentLoaded; the bytes themselves do not matter.
			setTimeout(() => {
				res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
				res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')
			}, SLOW_LOAD_MS)
			return
		}

		if (url.pathname === '/redirect') {
			res.writeHead(302, { Location: '/b' })
			res.end()
			return
		}

		res.writeHead(200, { 'Content-Type': 'text/html' })
		if (url.pathname === '/b') {
			res.end(page('nav-b', '<h1>B</h1><a id="to-a" href="/a">to A</a>'))
			return
		}
		if (url.pathname === '/slow') {
			res.end(page('nav-slow', '<h1>Slow</h1><img src="/slow-image" alt="">'))
			return
		}
		res.end(page('nav-a', '<h1>A</h1><a id="to-b" href="/b">to B</a><button id="noop">Nothing</button>'))
	})

describe('page navigation e2e', () => {
	let fx: CdpFixture
	let watcherId: string
	let site: Site
	let origin: string

	const goto = async (target: string, extra: string[] = []): Promise<NavigateResponse> =>
		fx.cli.json<NavigateResponse>(['page', 'goto', watcherId, target, '--json', ...extra])

	const readStatus = async (): Promise<StatusResponse> =>
		(await fetch(`http://127.0.0.1:${fx.watcher.port}/status`)).json() as Promise<StatusResponse>

	const evalValue = async (expression: string): Promise<unknown> =>
		(await fx.cli.json<EvalResponse>(['eval', watcherId, expression, '--json'])).result

	beforeAll(async () => {
		site = await createSite()
		origin = site.origin
		watcherId = `nav-e2e-${Date.now()}`

		fx = await startCdpFixture({
			prefix: 'argus-nav-e2e',
			runtime: 'node',
			watcher: { id: watcherId, match: { origin: `127.0.0.1:${site.port}` } },
			preparePage: (page) => page.goto(`${origin}/a`),
		})
	})

	afterAll(async () => {
		await fx?.close()
		await site?.close()
	})

	// ─────────────────────────────────────────────────────────────────────────
	// goto
	// ─────────────────────────────────────────────────────────────────────────

	test('goto navigates to an absolute URL and reports the load epoch', async () => {
		const response = await goto(`${origin}/a`)
		expect(response.ok).toBe(true)
		expect(response.url).toBe(`${origin}/a`)
		expect(response.requestedUrl).toBe(`${origin}/a`)
		expect(response.waited).toBe('load')
		expect(typeof response.epoch).toBe('string')
		expect(response.epoch.length).toBeGreaterThan(0)
		expect(await evalValue('document.title')).toBe('nav-a')
	})

	test('goto resolves a relative path against the current URL', async () => {
		await goto(`${origin}/a`)

		const response = await goto('/b')
		expect(response.requestedUrl).toBe(`${origin}/b`)
		expect(response.url).toBe(`${origin}/b`)
		expect(await evalValue('document.title')).toBe('nav-b')
	})

	test('goto with a query-only input keeps the path', async () => {
		await goto(`${origin}/b`)

		const response = await goto('?x=1')
		expect(response.url).toBe(`${origin}/b?x=1`)
		expect(await evalValue('location.pathname')).toBe('/b')
		expect(await evalValue('location.search')).toBe('?x=1')
	})

	test('goto --param merges into the current URL without a positional url', async () => {
		await goto(`${origin}/b?keep=1`)

		const response = await goto('', ['--param', 'debug=on'])
		expect(response.url).toBe(`${origin}/b?keep=1&debug=on`)
		expect(await evalValue('location.pathname')).toBe('/b')
	})

	test('goto --params overwrites existing values', async () => {
		await goto(`${origin}/b?over=old&keep=1`)

		const response = await goto('', ['--params', 'over=new'])
		expect(response.url).toBe(`${origin}/b?over=new&keep=1`)
	})

	test('goto --wait domcontentloaded returns before the slow load finishes', async () => {
		await goto(`${origin}/a`)

		const response = await goto('/slow', ['--wait', 'domcontentloaded'])
		expect(response.waited).toBe('domcontentloaded')
		expect(response.url).toBe(`${origin}/slow`)
		// The blocking image is still in flight, so `load` cannot have fired yet.
		expect(await evalValue('document.readyState')).not.toBe('complete')
	})

	test('goto --wait none returns without waiting for the document', async () => {
		await goto(`${origin}/a`)

		const started = Date.now()
		const response = await goto('/slow', ['--wait', 'none'])
		expect(response.waited).toBe('none')
		// Nothing was observed, so the reported URL is the requested one.
		expect(response.url).toBe(`${origin}/slow`)
		expect(Date.now() - started).toBeLessThan(SLOW_LOAD_MS)
	})

	test('goto to a hash on the same page settles without waiting for a load event', async () => {
		await goto(`${origin}/a`)
		const navigationsBefore = (await readStatus()).counters?.pageNavigations ?? 0

		// A same-document navigation fires no load event; waiting for one would burn the timeout.
		const started = Date.now()
		const response = await goto('#section')
		expect(response.url).toBe(`${origin}/a#section`)
		expect(Date.now() - started).toBeLessThan(5_000)
		expect(await evalValue('location.hash')).toBe('#section')
		expect(await evalValue('location.pathname')).toBe('/a')

		const status = await readStatus()
		// The reported URL must follow a same-document move, or the next relative goto resolves
		// against a stale URL and `page url` lies.
		expect(status.target?.url).toBe(`${origin}/a#section`)
		// ...but the document did not change, so it is not a page navigation.
		expect((status.counters?.pageNavigations ?? 0) - navigationsBefore).toBe(0)
	})

	test('goto reports the post-redirect URL', async () => {
		await goto(`${origin}/a`)

		const response = await goto('/redirect')
		expect(response.requestedUrl).toBe(`${origin}/redirect`)
		expect(response.url).toBe(`${origin}/b`)
	})

	test('goto to an unresolvable host fails with navigation_failed', async () => {
		const { stdout, code } = await fx.cli.exec(['page', 'goto', watcherId, 'http://argus-nav-e2e.invalid/', '--json'])
		expect(code).not.toBe(0)
		const response = JSON.parse(stdout) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.code).toBe('navigation_failed')

		await goto(`${origin}/a`)
	})

	test('goto times out with navigation_timeout when the load outlasts the budget', async () => {
		await goto(`${origin}/a`)

		const { stdout, code } = await fx.cli.exec(['page', 'goto', watcherId, '/slow', '--timeout', '100', '--json'])
		expect(code).not.toBe(0)
		const response = JSON.parse(stdout) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.code).toBe('navigation_timeout')
	})

	test('goto opens an epoch that scopes logs to the new page', async () => {
		await goto(`${origin}/a`)

		const response = await goto('/b')
		const { stdout } = await fx.cli.run(['logs', watcherId, '--since-epoch', response.epoch, '--json-full'])
		const messages = JSON.stringify(JSON.parse(stdout))
		expect(messages).toContain('loaded:nav-b')
		expect(messages).not.toContain('loaded:nav-a')
	})

	test('each goto counts exactly one page navigation', async () => {
		await goto(`${origin}/a`)
		const before = (await readStatus()).counters?.pageNavigations ?? 0

		await goto('/b')

		const after = (await readStatus()).counters?.pageNavigations ?? 0
		expect(after - before).toBe(1)
	})

	test('the top-level goto alias and the page nav alias reach the same command', async () => {
		await goto(`${origin}/b`)

		const { stdout: topLevel } = await fx.cli.run(['goto', watcherId, '/a', '--json'])
		expect((JSON.parse(topLevel) as NavigateResponse).url).toBe(`${origin}/a`)

		const { stdout: aliased } = await fx.cli.run(['page', 'nav', watcherId, '/b', '--json'])
		expect((JSON.parse(aliased) as NavigateResponse).url).toBe(`${origin}/b`)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// page url
	// ─────────────────────────────────────────────────────────────────────────

	test('page url prints the bare URL', async () => {
		await goto(`${origin}/b`)

		const { stdout } = await fx.cli.run(['page', 'url', watcherId])
		expect(stdout.trim()).toBe(`${origin}/b`)

		const { stdout: jsonOut } = await fx.cli.run(['page', 'url', watcherId, '--json'])
		const parsed = JSON.parse(jsonOut) as { url: string; title: string; attached: boolean }
		expect(parsed.url).toBe(`${origin}/b`)
		expect(parsed.title).toBe('nav-b')
		expect(parsed.attached).toBe(true)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// history
	// ─────────────────────────────────────────────────────────────────────────

	test('back and forward round-trip and report the history position', async () => {
		await goto(`${origin}/a`)
		await goto('/b')

		const { stdout: backOut } = await fx.cli.run(['page', 'back', watcherId, '--json'])
		const back = JSON.parse(backOut) as NavigateHistoryResponse
		expect(back.ok).toBe(true)
		expect(back.url).toBe(`${origin}/a`)
		expect(back.length).toBeGreaterThan(1)
		expect(back.index).toBe(back.length - 2)

		const { stdout: forwardOut } = await fx.cli.run(['page', 'forward', watcherId, '--json'])
		const forward = JSON.parse(forwardOut) as NavigateHistoryResponse
		expect(forward.url).toBe(`${origin}/b`)
		expect(forward.index).toBe(back.index + 1)
	})

	test('forward past the newest entry fails with no_history', async () => {
		await goto(`${origin}/a`)

		const { stdout, code } = await fx.cli.exec(['page', 'forward', watcherId, '--json'])
		expect(code).not.toBe(0)
		const response = JSON.parse(stdout) as ErrorResponse
		expect(response.ok).toBe(false)
		expect(response.error.code).toBe('no_history')
	})

	test('back past the oldest entry fails with no_history', async () => {
		await goto(`${origin}/a`)

		const { stdout, code } = await fx.cli.exec(['page', 'back', watcherId, '-n', '999', '--json'])
		expect(code).not.toBe(0)
		const response = JSON.parse(stdout) as ErrorResponse
		expect(response.error.code).toBe('no_history')
	})

	// ─────────────────────────────────────────────────────────────────────────
	// click --wait-nav
	// ─────────────────────────────────────────────────────────────────────────

	test('click --wait-nav reports the navigation a link caused', async () => {
		await goto(`${origin}/a`)

		const { stdout } = await fx.cli.run(['click', watcherId, '--selector', '#to-b', '--wait-nav', '--json'])
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.clicked).toBe(1)
		expect(response.navigation?.navigated).toBe(true)
		expect(response.navigation?.url).toBe(`${origin}/b`)
		expect(typeof response.navigation?.epoch).toBe('string')
	})

	test('click --wait-nav on a button reports no navigation without failing', async () => {
		await goto(`${origin}/a`)

		const { stdout } = await fx.cli.run(['click', watcherId, '--selector', '#noop', '--wait-nav', '--nav-timeout', '1s', '--json'])
		const response = JSON.parse(stdout) as DomClickResponse
		expect(response.clicked).toBe(1)
		expect(response.navigation?.navigated).toBe(false)
		expect(response.navigation?.url).toBeNull()
		expect(await evalValue('location.pathname')).toBe('/a')
	})
})
