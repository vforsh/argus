/**
 * Live extension-mode e2e: real Chromium + unpacked extension + native messaging hosts.
 *
 * This is the safety net for the frame_snapshot redesign (0fdf983): it drives iframe
 * selection across navigations and reloads — the exact path the extension's frame
 * bookkeeping and the watcher's reconstruction must keep working. It was written and run
 * green against the pre-redesign tree first, where it measured the defect the redesign
 * removed: two onPageNavigation firings per real navigation, now asserted as exactly one.
 * Skips itself when no Chromium/Chrome for Testing binary is available (branded Chrome
 * 137+ ignores --load-extension).
 */
import http from 'node:http'
import path from 'node:path'
import { readActiveRegistry, type LogsResponse } from '@vforsh/argus-core'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { ApiResult, EvalResponse, NavigateHistoryResponse, NavigateResponse, StatusResponse } from '@vforsh/argus-core'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'
import { startSession } from './helpers/session.js'

const chromeBin = resolveTestChromeBin()
const liveTest = chromeBin ? test : test.skip
if (!chromeBin) {
	console.warn('[extension-live] No Chromium/Chrome for Testing binary found; skipping. Set ARGUS_E2E_CHROME_BIN to enable.')
}

const WATCHER_ID = 'ext-live'
const STEP_TIMEOUT_MS = 90_000

let harness: ExtensionHarness

beforeAll(async () => {
	if (!chromeBin) return
	harness = await startExtensionHarness()
}, 120_000)

afterAll(async () => {
	await harness?.close()
})

const evalInSelectedTarget = async (expression: string): Promise<unknown> => {
	const response = await harness.cliJson<EvalResponse>('eval', WATCHER_ID, expression, '--json')
	expect(response.ok).toBe(true)
	expect(response.exception).toBeNull()
	return response.result
}

/** Poll an eval until the predicate holds; navigations make single-shot evals racy by design. */
const waitForEval = async (expression: string, predicate: (value: unknown) => boolean, timeoutMs = 30_000): Promise<unknown> => {
	const deadline = Date.now() + timeoutMs
	let lastValue: unknown
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			lastValue = await evalInSelectedTarget(expression)
			if (predicate(lastValue)) {
				return lastValue
			}
		} catch (error) {
			lastError = error
		}
		await sleep(500)
	}
	throw new Error(
		`waitForEval timed out for ${expression}.\nlast value: ${JSON.stringify(lastValue)}\nlast error: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'none')}`,
	)
}

const pageNavigations = async (): Promise<number> => {
	const status = await harness.cliJson<StatusResponse>('watcher', 'status', WATCHER_ID, '--json')
	expect(status.ok).toBe(true)
	return status.counters?.pageNavigations ?? 0
}

const selectIframeByUrl = async (urlSubstring: string): Promise<void> => {
	const result = await harness.cli('ext', 'select', WATCHER_ID, '--iframe-url', urlSubstring, '--json')
	expect(result.code).toBe(0)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const assertTextSelectionInFrame = async (): Promise<void> => {
	await evalInSelectedTarget(`(() => {
		let scope = document.getElementById('argus-text-scope'); if (scope) scope.remove();
		scope = document.createElement('section'); scope.id = 'argus-text-scope';
		for (let i = 0; i < 1000; i++) {
			const button = document.createElement('button'); button.className = 'argus-text-candidate';
			button.id = 'frame-button-' + i; button.textContent = i === 999 ? ' Frame Needle ' : 'Other';
			button.onclick = () => { document.body.dataset.argusClicked = button.id }; scope.append(button);
		}
		document.body.append(scope); return true;
	})()`)
	const info = await harness.cliJson<{ ok: boolean; matches: number; elements: Array<{ ref: string; attributes: { id: string } }> }>(
		'dom', 'info', WATCHER_ID, '--selector', '.argus-text-candidate', '--text', '/frame needle/i', '--json',
	)
	expect(info).toMatchObject({ ok: true, matches: 1 })
	expect(info.elements[0]?.attributes.id).toBe('frame-button-999')
	expect((await harness.cli('click', WATCHER_ID, '--ref', info.elements[0]!.ref, '--json')).code).toBe(0)
	expect(await evalInSelectedTarget('document.body.dataset.argusClicked')).toBe('frame-button-999')
}

liveTest(
	'0: recovers a real Argus-owned debugger absent from extension bookkeeping',
	async () => {
		const tabId = await harness.evaluateInExtension<number>(`(async () => {
			const tab = (await chrome.tabs.query({})).find(t => t.url.includes(${JSON.stringify(harness.pageUrlSubstring)}));
			await chrome.debugger.attach({tabId: tab.id}, '1.3');
			await chrome.debugger.sendCommand({tabId: tab.id}, 'Target.setAutoAttach', {
				autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
				filter: [{type: 'iframe', exclude: false}]
			});
			return tab.id;
		})()`)
		const tabs = await harness.cliJson<{ tabs: Array<{ tabId: number; attached: boolean }> }>('ext', 'tabs', '--json')
		expect(tabs.tabs.find((tab) => tab.tabId === tabId)?.attached).toBe(false)
		const attached = await harness.cli('ext', 'attach', '--tab', String(tabId), '--as', WATCHER_ID, '--json')
		expect(attached.code).toBe(0)
		await waitForEval('location.href', (value) => typeof value === 'string' && value.includes(harness.pageUrlSubstring))
		// Subsequent cases verify that existing same-origin and OOPIF frames were rediscovered.
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'A: attaching by URL creates a tab watcher whose eval hits the top page',
	async () => {
		const use = await harness.cli('ext', 'use', '--url', harness.pageUrlSubstring, '--as', WATCHER_ID, '--json')
		expect(use.code).toBe(0)

		const href = await waitForEval('location.href', (value) => typeof value === 'string' && value.includes(harness.pageUrlSubstring))
		expect(String(href)).not.toContain('iframe.html')
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'B: selecting the same-origin iframe routes eval into the iframe document',
	async () => {
		await selectIframeByUrl(`${harness.pageUrlSubstring}/iframe.html`)
		await waitForEval('location.href', (value) => typeof value === 'string' && value.includes(`${harness.pageUrlSubstring}/iframe.html`))
		await assertTextSelectionInFrame()
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'C: iframe selection and eval routing survive a top-page navigation',
	async () => {
		const navigationsBefore = await pageNavigations()

		// The selected same-origin iframe navigates its own top page; the iframe document
		// (and its frame id) are torn down and recreated by the navigation.
		await harness.cli('eval', WATCHER_ID, `top.location.href = ${JSON.stringify(`${harness.pageUrl}/?nav=c`)}`, '--json')

		const href = await waitForEval(
			'location.href',
			(value) => typeof value === 'string' && value.includes(`${harness.pageUrlSubstring}/iframe.html`),
		)
		expect(String(href)).toContain('iframe.html')

		const navigationsAfter = await pageNavigations()
		const delta = navigationsAfter - navigationsBefore
		// Exactly one: the real top-frame Page.frameNavigated and nothing else. Pre-C2 this
		// was 2 — the extension replayed a fabricated copy through the frame-tree resync,
		// re-rotating logs and dropping sourcemap caches for a navigation that never happened.
		expect(delta).toBe(1)
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'D: selecting the cross-origin iframe (OOPIF child session) routes eval into it',
	async () => {
		const crossOriginSubstring = harness.crossOriginUrl.replace('http://', '')
		await selectIframeByUrl(`${crossOriginSubstring}/iframe.html`)
		await waitForEval('location.href', (value) => typeof value === 'string' && value.includes(`${crossOriginSubstring}/iframe.html`))
		await assertTextSelectionInFrame()
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'E: cross-origin iframe selection survives a page reload (target recovery)',
	async () => {
		const navigationsBefore = await pageNavigations()

		const reload = await harness.cli('reload', WATCHER_ID, '--json')
		expect(reload.code).toBe(0)

		const crossOriginSubstring = harness.crossOriginUrl.replace('http://', '')
		await waitForEval('location.href', (value) => typeof value === 'string' && value.includes(`${crossOriginSubstring}/iframe.html`), 45_000)
		await assertTextSelectionInFrame()

		const delta = (await pageNavigations()) - navigationsBefore
		// Exactly one, same contract as scenario C (pre-C2 a reload also counted twice).
		expect(delta).toBe(1)
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'F: removing the selected cross-origin iframe drops its target without killing the watcher',
	async () => {
		// Move eval back to the page so the DOM mutation does not depend on the doomed iframe.
		const page = await harness.cli('ext', 'select', WATCHER_ID, '--page', '--json')
		expect(page.code).toBe(0)
		await waitForEval('location.href', (value) => typeof value === 'string' && !value.includes('iframe.html'))

		await evalInSelectedTarget(`document.getElementById('cross-origin-iframe').remove(); 'removed'`)

		const crossOriginSubstring = harness.crossOriginUrl.replace('http://', '')
		const deadline = Date.now() + 30_000
		let targetsJson = ''
		while (Date.now() < deadline) {
			const targets = await harness.cli('ext', 'targets', WATCHER_ID, '--json')
			targetsJson = targets.stdout
			if (targets.code === 0 && !targetsJson.includes(`${crossOriginSubstring}/iframe.html`)) {
				break
			}
			await sleep(500)
		}
		expect(targetsJson).not.toContain(`${crossOriginSubstring}/iframe.html`)

		// The watcher itself must stay healthy after losing a child session.
		const status = await harness.cliJson<StatusResponse>('watcher', 'status', WATCHER_ID, '--json')
		expect(status.ok).toBe(true)
		expect(status.attached).toBe(true)
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'G: goto and back drive navigation over the extension debugger session',
	async () => {
		const navigationsBefore = await pageNavigations()

		// Relative to the page's current URL, resolved by the watcher — the same code path as CDP mode.
		const goto = await harness.cliJson<NavigateResponse>('page', 'goto', WATCHER_ID, '/nav/second.html', '--json')
		expect(goto.ok).toBe(true)
		expect(goto.url).toContain('/nav/second.html')
		// The wait settled, which is only possible if the real Page.loadEventFired reached the
		// watcher through cdp-proxy's unfiltered debugger-event forwarding.
		expect(goto.waited).toBe('load')
		await waitForEval('location.pathname', (value) => value === '/nav/second.html')

		const url = await harness.cliJson<{ url: string }>('page', 'url', WATCHER_ID, '--json')
		expect(url.url).toContain('/nav/second.html')

		// A back navigation into the bfcache fires no load event, so this also covers the
		// BackForwardCacheRestore settle path — it hung for the full timeout before that existed.
		const back = await harness.cliJson<ApiResult<NavigateHistoryResponse>>('page', 'back', WATCHER_ID, '--json')
		if (!back.ok) throw new Error(`page back failed: ${JSON.stringify(back)}`)
		expect(back.url).not.toContain('/nav/second.html')
		expect(back.length).toBeGreaterThan(1)
		await waitForEval('location.pathname', (value) => value !== '/nav/second.html')

		// Two real top-frame navigations, one each — the same one-per-navigation contract as C and E.
		expect((await pageNavigations()) - navigationsBefore).toBe(2)
	},
	STEP_TIMEOUT_MS,
)

liveTest(
	'H: mute and unmute change the real Chrome tab state',
	async () => {
		const tabId = await harness.evaluateInExtension<number>(`(async () => {
			const tab = (await chrome.tabs.query({})).find(t => t.url.includes(${JSON.stringify(harness.pageUrlSubstring)}));
			return tab.id;
		})()`)

		const mute = await harness.cliJson<{ ok: boolean; muted: boolean; tab: { tabId: number } }>('ext', 'mute', WATCHER_ID, '--json')
		expect(mute).toMatchObject({ ok: true, muted: true, tab: { tabId } })
		expect(await harness.evaluateInExtension<boolean>(`(async () => (await chrome.tabs.get(${tabId})).mutedInfo.muted)()`)).toBe(true)

		const unmute = await harness.cliJson<{ ok: boolean; muted: boolean; tab: { tabId: number } }>(
			'ext',
			'unmute',
			'--tab',
			String(tabId),
			'--json',
		)
		expect(unmute).toMatchObject({ ok: true, muted: false, tab: { tabId } })
		expect(await harness.evaluateInExtension<boolean>(`(async () => (await chrome.tabs.get(${tabId})).mutedInfo.muted)()`)).toBe(false)
	},
	STEP_TIMEOUT_MS,
)


liveTest('I: raw/final ingestion through the real extension bridge preserves order and cursors under a cold map', async () => {
	const server = http.createServer((req, res) => {
		if (req.url === '/slow.map') {
			setTimeout(() => res.end(JSON.stringify({ version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA' })), 250)
		} else if (req.url === '/bundle.js') {
			res.end('window.emit = text => console.log(text);\n//# sourceMappingURL=/slow.map')
		} else {
			res.setHeader('content-type', 'text/html')
			res.end('<script src="/bundle.js"></script>')
		}
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	try {
		const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
		expect((await harness.cli('ext', 'select', WATCHER_ID, '--page', '--json')).code).toBe(0)
		expect((await harness.cli('goto', WATCHER_ID, url, '--json')).code).toBe(0)
		await waitForEval('typeof window.emit', (value) => value === 'function')
		const watcher = (await readActiveRegistry({ registryPath: harness.registryPath })).watchers[WATCHER_ID]!
		const endpoint = `http://${watcher.host}:${watcher.port}`
		const json = async <T>(path: string): Promise<T> => (await (await fetch(endpoint + path)).json()) as T
		const { cursor } = await json<{ cursor: string }>('/logs/cursor')
		const rawWaiting = json<LogsResponse>(`/tail?after=${cursor}&raw=1`)
		const finalWaiting = json<LogsResponse>(`/tail?after=${cursor}`)
		await evalInSelectedTarget('window.emit("extension-first"); console.log("extension-second"); true')
		const raw = await rawWaiting
		const final = await finalWaiting
		expect(raw.events[0]?.text).toBe('extension-first')
		expect(raw.events[0]?.file).toContain('/bundle.js')
		expect(final.events[0]?.text).toBe('extension-first')
		expect(final.events[0]?.file).toContain('/original.ts')
		expect(final.events[0]?.id).toBe(raw.events[0]?.id)
		const all = await json<LogsResponse>(`/logs?after=${cursor}`)
		expect(all.events.filter((event) => event.text.startsWith('extension-')).map((event) => event.text))
			.toEqual(['extension-first', 'extension-second'])
		expect((await json<LogsResponse>(`/logs?after=${all.nextCursor}`)).events).toHaveLength(0)
	} finally {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
}, STEP_TIMEOUT_MS)

liveTest(
	'J: session dialog controls overtake the in-flight eval that opened the dialog',
	async () => {
		const env = { ...process.env, ARGUS_HOME: path.dirname(harness.registryPath), ARGUS_REGISTRY_PATH: harness.registryPath }
		const session = startSession(path.resolve('packages/argus/dist/bin.js'), [WATCHER_ID, '--request-timeout', '20s'], { env, cwd: process.cwd() })
		try {
			expect(await session.next()).toMatchObject({ type: 'ready', watcher: { id: WATCHER_ID } })
			session.send({ id: 'eval', cmd: 'eval', args: { expression: "window.confirm('extension-confirm')" } })
			session.send({ id: 'status', cmd: 'dialog status' })
			session.send({ id: 'accept', cmd: 'dialog accept' })

			const responses = [await session.next(), await session.next(), await session.next()]
			expect(responses.map((response) => response.id)).toEqual(['status', 'accept', 'eval'])
			expect(responses[0]).toMatchObject({ ok: true, result: { dialog: { type: 'confirm', message: 'extension-confirm' } } })
			expect(responses[1]).toMatchObject({ ok: true, result: { action: 'accept' } })
			expect(responses[2]).toMatchObject({ ok: true, result: { result: true } })
		} finally {
			await session.close(5_000)
		}
	},
	STEP_TIMEOUT_MS,
)
