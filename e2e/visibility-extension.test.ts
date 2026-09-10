/** Live extension coverage for the visibility policy and page-scoped routes. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { DomKeydownResponse, EvalResponse, VisibilityResponse } from '@vforsh/argus-core'
import { readForegroundApp, restoreForegroundApp } from './helpers/foreground.js'
import { delay } from '@vforsh/argus-core'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'

const chromeBin = resolveTestChromeBin()
const liveTest = chromeBin ? test : test.skip
if (!chromeBin) {
	console.warn('[visibility-extension] No Chromium/Chrome for Testing binary found; skipping. Set ARGUS_E2E_CHROME_BIN to enable.')
}

const WATCHER_ID = 'visibility-extension'

let harness: ExtensionHarness
let foregroundApp: string | null = null

beforeAll(async () => {
	if (!chromeBin) return
	foregroundApp = await readForegroundApp()
	harness = await startExtensionHarness()
	const attached = await harness.cli('ext', 'use', '--url', harness.pageUrlSubstring, '--as', WATCHER_ID, '--json')
	expect(attached.code).toBe(0)
}, 120_000)

afterAll(async () => {
	await harness?.close()
})

type VisibilityStatus = VisibilityResponse

const evalExtension = <T = unknown>(expression: string): Promise<T> => harness.evaluateInExtension<T>(`(async () => (${expression}))()`)

const readVisibility = (): Promise<VisibilityStatus> => harness.cliJson<VisibilityStatus>('page', 'visibility', WATCHER_ID, '--json')

const evalPage = async <T>(expression: string): Promise<T> => {
	const response = await harness.cliJson<EvalResponse>('eval', WATCHER_ID, expression, '--json')
	expect(response.ok).toBe(true)
	return response.result as T
}

const waitFor = async <T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	let value: T
	do {
		value = await read()
		if (predicate(value)) return value
		await delay(250)
	} while (Date.now() < deadline)
	throw new Error(`Timed out after ${timeoutMs}ms; last value: ${JSON.stringify(value!)}`)
}

liveTest(
	'keeps background mode across extension navigation without changing the active tab',
	async () => {
		const watchedTabId = await evalExtension<number>(
			`(await chrome.tabs.query({})).find(tab => tab.url?.includes(${JSON.stringify(harness.pageUrlSubstring)}))?.id`,
		)
		expect(typeof watchedTabId).toBe('number')

		// Put another tab in the foreground. This checks tab activation in headless Chromium;
		// Headed macOS runs also record and assert the foreground application at each step.
		const decoyTabId = await evalExtension<number>(`(await chrome.tabs.create({url: 'about:blank', active: true})).id`)
		await restoreForegroundApp(foregroundApp)
		const assertBackground = async (phase: string): Promise<void> => {
			expect(await evalExtension<number>(`(await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]?.id`)).toBe(decoyTabId)
			const app = await readForegroundApp()
			if (foregroundApp) expect(app).toBe(foregroundApp)
			console.info('[visibility-extension evidence]', JSON.stringify({ phase, app, activeTab: decoyTabId }))
		}
		try {
			await assertBackground('before')
			expect(await evalExtension<number>(`(await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]?.id`)).toBe(decoyTabId)

			const initial = await readVisibility()
			expect(initial).toMatchObject({ ok: true, attached: true, state: 'default', policy: 'foreground' })

			const shown = await harness.cliJson<VisibilityStatus>('page', 'show', WATCHER_ID, '--policy', 'background', '--json')
			expect(shown).toMatchObject({ ok: true, attached: true, state: 'shown', policy: 'background' })
			expect(await evalExtension<number>(`(await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]?.id`)).toBe(decoyTabId)

			await evalPage<void>(
				'globalThis.__visibilityFrames = 0; requestAnimationFrame(function tick() { globalThis.__visibilityFrames += 1; requestAnimationFrame(tick) }); true',
			)
			await assertBackground('show')
			const framesBefore = await evalPage<number>('globalThis.__visibilityFrames')
			await delay(300)
			expect(await evalPage<number>('globalThis.__visibilityFrames')).toBeGreaterThan(framesBefore)

			await evalPage<void>(
				"globalThis.__visibilityKeydowns = 0; document.querySelector('#input-name')?.addEventListener('keydown', () => globalThis.__visibilityKeydowns += 1); true",
			)
			const keydown = await harness.cliJson<DomKeydownResponse>('keydown', WATCHER_ID, '--key', 'x', '--selector', '#input-name', '--json')
			expect(keydown).toMatchObject({ ok: true, activated: false })
			expect(await evalPage<number>('globalThis.__visibilityKeydowns')).toBe(1)
			await assertBackground('keyboard')

			await evalPage(`(() => {
				const el = document.createElement('div'); el.id = 'visibility-pointer';
				el.style.cssText = 'position:fixed;top:10px;left:10px;width:100px;height:50px;z-index:99999;background:red';
				document.body.appendChild(el);
				globalThis.__visibilityDown = 0; globalThis.__visibilityUp = 0;
				el.addEventListener('mousedown', () => globalThis.__visibilityDown++);
				el.addEventListener('mouseup', () => globalThis.__visibilityUp++);
				return true;
			})()`)
			const click = await harness.cli('click', WATCHER_ID, '--selector', '#visibility-pointer', '--json')
			expect(click.code).toBe(0)
			expect(JSON.parse(click.stdout)).toMatchObject({ ok: true, clicked: 1 })
			const drag = await harness.cli('drag', WATCHER_ID, '--selector', '#visibility-pointer', '--by', '20,0', '--json')
			expect(drag.code).toBe(0)
			expect(JSON.parse(drag.stdout)).toMatchObject({ ok: true, dragged: 1 })
			expect(await evalPage<{ down: number; up: number }>('({down: globalThis.__visibilityDown, up: globalThis.__visibilityUp})')).toEqual({
				down: 2,
				up: 2,
			})
			await assertBackground('click-and-drag')

			for (const command of [['screenshot'], ['record', 'start']]) {
				const result = await harness.cli(...command, WATCHER_ID, '--json')
				expect(result.code).not.toBe(0)
				expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'not_available' } })
				await assertBackground(command.join(' '))
			}

			const reload = await harness.cli('reload', WATCHER_ID, '--json')
			expect(reload.code).toBe(0)
			await waitFor(
				() => evalPage<string>('document.readyState'),
				(state) => state === 'complete',
			)
			expect(await readVisibility()).toMatchObject({ ok: true, attached: true, state: 'shown', policy: 'background' })
			expect(await evalPage<boolean>('new Promise(resolve => requestAnimationFrame(() => resolve(document.hasFocus())))')).toBe(true)
			await assertBackground('reload')

			const hidden = await harness.cliJson<VisibilityStatus>('page', 'hide', WATCHER_ID, '--json')
			expect(hidden).toMatchObject({ ok: true, attached: true, state: 'default', policy: 'background' })
			await harness.cli('page', 'show', WATCHER_ID, '--policy', 'foreground', '--no-activate', '--json')
			await assertBackground('restore-shown-without-activation')
			await harness.cli('page', 'show', WATCHER_ID, '--policy', 'foreground', '--json')
			expect(await evalExtension<number>(`(await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]?.id`)).toBe(watchedTabId)
		} finally {
			await evalExtension(`chrome.tabs.remove(${decoyTabId})`)
			await harness.cli('page', 'hide', WATCHER_ID, '--policy', 'foreground', '--no-activate', '--json')
			await restoreForegroundApp(foregroundApp)
		}
	},
	120_000,
)
