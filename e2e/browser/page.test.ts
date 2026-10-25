import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Browser } from 'playwright'
import { launchDebuggableBrowser } from '../helpers/browser.js'
import { argusEnv, createCli, type Cli } from '../helpers/cli.js'
import { startSite, type Site } from '../helpers/site.js'
import { makeTempDir, removeDir } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

/** Serve a plain-text echo of the request URL for one test, closing it whatever happens. */
const withQueryEchoSite = async (fn: (site: Site) => Promise<void>): Promise<void> => {
	const site = await startSite((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain' })
		res.end(`Query: ${req.url}`)
	})
	try {
		await fn(site)
	} finally {
		await site.close()
	}
}

describe('page command e2e', () => {
	let tempDir: string
	let browser: Browser | undefined
	let cdpArgs: string[]
	let cli: Cli

	beforeAll(async () => {
		tempDir = await makeTempDir('argus-page-e2e')
		cli = createCli({ env: argusEnv(tempDir) })
		const debuggable = await launchDebuggableBrowser()
		browser = debuggable.browser

		const context = await browser.newContext()
		const page = await context.newPage()
		await page.setContent('<html><head><title>page-e2e</title></head><body><h1>Page E2E</h1></body></html>')

		cdpArgs = ['--cdp', debuggable.cdpAddress]
	})

	afterAll(async () => {
		await browser?.close()
		await removeDir(tempDir)
	})

	test('page targets lists tabs', async () => {
		const targets = await cli.json<Array<{ id: string; type: string; title: string }>>(['page', 'targets', ...cdpArgs, '--json'])
		expect(Array.isArray(targets)).toBe(true)
		expect(targets.some((t) => t.title === 'page-e2e')).toBe(true)
	})

	test('tab alias works for page targets', async () => {
		const targets = await cli.json<Array<{ id: string; type: string; title: string }>>(['tab', 'targets', ...cdpArgs, '--json'])
		expect(targets.some((t) => t.title === 'page-e2e')).toBe(true)
	})

	test('page list/ls aliases work', async () => {
		const listTargets = await cli.json<Array<{ id: string }>>(['page', 'list', ...cdpArgs, '--json'])
		expect(Array.isArray(listTargets)).toBe(true)

		const lsTargets = await cli.json<Array<{ id: string }>>(['page', 'ls', ...cdpArgs, '--json'])
		expect(Array.isArray(lsTargets)).toBe(true)
	})

	test('page open creates new tab', async () => {
		const target = await cli.json<{ id: string; url: string }>(['page', 'open', '--url', 'about:blank', ...cdpArgs, '--json'])
		expect(target.id).toBeTruthy()

		const targets = await cli.json<Array<{ id: string }>>(['page', 'targets', ...cdpArgs, '--json'])
		expect(targets.some((t) => t.id === target.id)).toBe(true)
	})

	test('page new alias works', async () => {
		const target = await cli.json<{ id: string }>(['page', 'new', '--url', 'about:blank', ...cdpArgs, '--json'])
		expect(target.id).toBeTruthy()
	})

	test('page activate focuses tab', async () => {
		const targets = await cli.json<Array<{ id: string }>>(['page', 'targets', ...cdpArgs, '--json', '--type', 'page'])
		expect(targets.length > 0).toBe(true)

		const targetId = targets[0].id
		const result = await cli.json<{ activated: string }>(['page', 'activate', targetId, ...cdpArgs, '--json'])
		expect(result.activated).toBe(targetId)
	})

	test('page reload reloads tab', async () => {
		const targets = await cli.json<Array<{ id: string; title: string }>>(['page', 'targets', ...cdpArgs, '--json', '--type', 'page'])
		const testPage = targets.find((t) => t.title === 'page-e2e')
		expect(testPage).toBeTruthy()

		const result = await cli.json<{ reloaded: string }>(['page', 'reload', testPage!.id, ...cdpArgs, '--json'])
		expect(result.reloaded).toBe(testPage!.id)
	})

	test('page reload --param updates query string', async () => {
		await withQueryEchoSite(async (site) => {
			const newTarget = await cli.json<{ id: string; url: string }>(['page', 'open', '--url', `${site.origin}/test?initial=1`, ...cdpArgs, '--json'])
			expect(newTarget.id).toBeTruthy()
			expect(newTarget.url).toMatch(/initial=1/)

			await new Promise((r) => setTimeout(r, 500))

			const reloadResult = await cli.json<{ reloaded: string; url: string; previousUrl: string }>([
				'page',
				'reload',
				newTarget.id,
				'--param',
				'foo=bar',
				'--param',
				'baz=qux',
				...cdpArgs,
				'--json',
			])
			expect(reloadResult.reloaded).toBe(newTarget.id)
			expect(reloadResult.url).toMatch(/foo=bar/)
			expect(reloadResult.url).toMatch(/baz=qux/)
			expect(reloadResult.url).toMatch(/initial=1/)
			expect(reloadResult.previousUrl).toBeTruthy()
		})
	})

	test('page reload --params updates query string', async () => {
		await withQueryEchoSite(async (site) => {
			const newTarget = await cli.json<{ id: string }>(['page', 'open', '--url', `${site.origin}/test`, ...cdpArgs, '--json'])

			await new Promise((r) => setTimeout(r, 500))

			const reloadResult = await cli.json<{ url: string }>(['page', 'reload', newTarget.id, '--params', 'a=1&b=2', ...cdpArgs, '--json'])
			expect(reloadResult.url).toMatch(/a=1/)
			expect(reloadResult.url).toMatch(/b=2/)
		})
	})

	test('page reload --param rejects non-http URLs', async () => {
		const targets = await cli.json<Array<{ id: string; url: string }>>(['page', 'targets', ...cdpArgs, '--json', '--type', 'page'])
		const blankPage = targets.find((t) => t.url === 'about:blank')
		expect(blankPage).toBeTruthy()

		const { stderr, code } = await cli.exec(['page', 'reload', blankPage!.id, '--param', 'foo=bar', ...cdpArgs])
		expect(code).toBe(2)
		expect(stderr).toMatch(/not http\/https/)
	})

	test('page reload --param rejects malformed param', async () => {
		const targets = await cli.json<Array<{ id: string; url: string }>>(['page', 'targets', ...cdpArgs, '--json', '--type', 'page'])
		const httpPage = targets.find((t) => t.url.startsWith('http'))
		expect(httpPage).toBeTruthy()

		const { stderr: noEqStderr, code: noEqCode } = await cli.exec(['page', 'reload', httpPage!.id, '--param', 'noequals', ...cdpArgs])
		expect(noEqCode).toBe(2)
		expect(noEqStderr).toMatch(/missing "="/)

		const { stderr: emptyKeyStderr, code: emptyKeyCode } = await cli.exec(['page', 'reload', httpPage!.id, '--param', '=value', ...cdpArgs])
		expect(emptyKeyCode).toBe(2)
		expect(emptyKeyStderr).toMatch(/empty key/)
	})

	// Navigation flags are validated before the watcher is resolved, so these need no watcher.
	test('goto rejects a call with neither a url nor query overrides', async () => {
		const { stderr, code } = await cli.exec(['goto', 'no-such-watcher'])
		expect(code).toBe(2)
		expect(stderr).toMatch(/<url> is required/)
	})

	test('goto rejects an unknown --wait mode', async () => {
		const { stderr, code } = await cli.exec(['goto', 'no-such-watcher', '/x', '--wait', 'networkidle'])
		expect(code).toBe(2)
		expect(stderr).toMatch(/Invalid --wait value/)
	})

	test('goto rejects an unparseable --timeout', async () => {
		const { stderr, code } = await cli.exec(['goto', 'no-such-watcher', '/x', '--timeout', 'soon'])
		expect(code).toBe(2)
		expect(stderr).toMatch(/Invalid --timeout value/)
	})

	test('page back rejects a non-positive --steps', async () => {
		const { stderr, code } = await cli.exec(['page', 'back', 'no-such-watcher', '-n', '0'])
		expect(code).toBe(2)
		expect(stderr).toMatch(/Invalid --steps value/)
	})

	test('page close closes tab', async () => {
		const target = await cli.json<{ id: string }>(['page', 'open', '--url', 'about:blank', ...cdpArgs, '--json'])

		const result = await cli.json<{ closed: string }>(['page', 'close', target.id, ...cdpArgs, '--json'])
		expect(result.closed).toBe(target.id)

		const targets = await cli.json<Array<{ id: string }>>(['page', 'targets', ...cdpArgs, '--json'])
		expect(targets.some((t) => t.id === target.id)).toBe(false)
	})
})
