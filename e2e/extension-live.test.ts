/**
 * Live extension-mode e2e: real Chromium + unpacked extension + native messaging hosts.
 *
 * This is the safety net for the C2 frame_snapshot redesign (tasks/c2-frame-snapshot.md):
 * it drives iframe selection across navigations and reloads — the exact path the
 * extension's frame bookkeeping and the watcher's reconstruction must keep working.
 * Skips itself when no Chromium/Chrome for Testing binary is available (branded Chrome
 * 137+ ignores --load-extension).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { EvalResponse, StatusResponse } from '@vforsh/argus-core'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'

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
