import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Page } from 'playwright'
import type { DomKeydownResponse, EvalResponse, VisibilityResponse } from '@vforsh/argus-core'
import { delay } from '@vforsh/argus-core'
import { startCdpFixture, type CdpFixture } from '../helpers/browser.js'
import { readForegroundApp, restoreForegroundApp } from '../helpers/foreground.js'
import { waitFor } from '../helpers/poll.js'
import { htmlPage, startSite, type Site } from '../helpers/site.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

const WATCHER_ID = 'visibility-cdp'

type VisibilityStatus = VisibilityResponse

const pageHtml = `<!doctype html>
<html>
  <head><title>Argus visibility e2e</title></head>
  <body>
    <input id="visibility-input" type="text" />
    <script>
      globalThis.__visibilityFrames = 0
      globalThis.__visibilityKeydowns = 0
    </script>
  </body>
</html>`

describe('visibility over the CDP watcher', () => {
	let fx: CdpFixture
	let browserPage: Page
	let decoyPage: Page
	let foregroundApp: string | null = null
	let site: Site

	const cliJson = <T = Record<string, unknown>>(...args: string[]): Promise<T> => fx.cli.json<T>([...args, '--json'])

	const evalValue = async <T = unknown>(expression: string): Promise<T> => {
		const response = await cliJson<EvalResponse>('eval', WATCHER_ID, expression)
		expect(response.ok).toBe(true)
		return response.result as T
	}

	const readVisibility = (): Promise<VisibilityStatus> => cliJson<VisibilityStatus>('page', 'visibility', WATCHER_ID)

	const assertBackground = async (phase: string): Promise<void> => {
		const app = await readForegroundApp()
		if (foregroundApp) expect(app).toBe(foregroundApp)
		expect(await decoyPage.evaluate(() => document.visibilityState)).toBe('visible')
		console.info('[visibility-cdp evidence]', JSON.stringify({ phase, app, decoyVisible: true }))
	}

	beforeAll(async () => {
		site = await startSite(htmlPage(pageHtml))

		foregroundApp = await readForegroundApp()
		fx = await startCdpFixture({
			prefix: 'argus-visibility-e2e',
			watcher: { id: WATCHER_ID, match: { origin: `127.0.0.1:${site.port}` } },
			preparePage: (page) => page.goto(site.origin),
			runtime: 'node',
			launch: { headless: process.env.ARGUS_E2E_HEADED !== '1' },
		})
		browserPage = fx.page
		decoyPage = await fx.context.newPage()
		await decoyPage.goto('about:blank')
		await decoyPage.bringToFront()
		await restoreForegroundApp(foregroundApp)
	})

	afterAll(async () => {
		await fx?.close()
		await site?.close()
	})

	test('reads status without changing the lock and runs rAF/input in background policy', async () => {
		await assertBackground('before')
		const beforeFocus = await evalValue<boolean>('document.hasFocus()')
		const initial = await readVisibility()
		expect(initial).toMatchObject({ ok: true, attached: true, state: 'default', policy: 'foreground' })
		expect(await evalValue<boolean>('document.hasFocus()')).toBe(beforeFocus)
		expect(await readVisibility()).toMatchObject({ ok: true, attached: true, state: 'default', policy: 'foreground' })

		const shown = await cliJson<VisibilityStatus>('page', 'show', WATCHER_ID, '--policy', 'background')
		expect(shown).toMatchObject({ ok: true, attached: true, state: 'shown', policy: 'background' })
		await assertBackground('show')

		await browserPage.evaluate(() => {
			const state = globalThis as typeof globalThis & { __visibilityFrames: number }
			const tick = () => {
				state.__visibilityFrames += 1
				requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
		})
		const framesBefore = await evalValue<number>('globalThis.__visibilityFrames')
		await delay(300)
		expect(await evalValue<number>('globalThis.__visibilityFrames')).toBeGreaterThan(framesBefore)

		await browserPage.evaluate(() => {
			const state = globalThis as typeof globalThis & { __visibilityKeydowns: number }
			document.querySelector('#visibility-input')?.addEventListener('keydown', () => {
				state.__visibilityKeydowns += 1
			})
		})
		const keydown = await cliJson<DomKeydownResponse>('keydown', WATCHER_ID, '--key', 'x', '--selector', '#visibility-input')
		expect(keydown).toMatchObject({ ok: true, activated: false })
		expect(await evalValue<number>('globalThis.__visibilityKeydowns')).toBe(1)
		await assertBackground('keyboard')

		await evalValue(`(() => {
			const el = document.createElement('div'); el.id = 'visibility-pointer';
			el.style.cssText = 'position:fixed;top:60px;left:10px;width:100px;height:50px;background:red';
			document.body.appendChild(el);
			globalThis.__visibilityDown = 0; globalThis.__visibilityUp = 0;
			el.addEventListener('mousedown', () => globalThis.__visibilityDown++);
			el.addEventListener('mouseup', () => globalThis.__visibilityUp++);
			return true;
		})()`)
		expect(await cliJson('click', WATCHER_ID, '--selector', '#visibility-pointer')).toMatchObject({ ok: true, clicked: 1 })
		expect(await cliJson('drag', WATCHER_ID, '--selector', '#visibility-pointer', '--by', '20,0')).toMatchObject({ ok: true, dragged: 1 })
		expect(await evalValue<{ down: number; up: number }>('({down: globalThis.__visibilityDown, up: globalThis.__visibilityUp})')).toEqual({
			down: 2,
			up: 2,
		})
		await assertBackground('click-and-drag')
		for (const command of [['screenshot'], ['record', 'start']]) {
			const result = await fx.cli.exec([...command, WATCHER_ID, '--json'])
			expect(result.code).not.toBe(0)
			expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'not_available' } })
			await assertBackground(command.join(' '))
		}

		const hidden = await cliJson<VisibilityStatus>('page', 'hide', WATCHER_ID)
		expect(hidden).toMatchObject({ ok: true, attached: true, state: 'default', policy: 'background' })

		const foreground = await cliJson<VisibilityStatus>('page', 'show', WATCHER_ID, '--policy', 'foreground', '--no-activate')
		expect(foreground).toMatchObject({ ok: true, attached: true, state: 'shown', policy: 'foreground' })
		await cliJson<VisibilityStatus>('page', 'hide', WATCHER_ID, '--no-activate')
		await assertBackground('restore')
	})

	test('keeps the desired background policy readable while detached and reapplies it after reattach', async () => {
		const shown = await cliJson<VisibilityStatus>('page', 'show', WATCHER_ID, '--policy', 'background')
		expect(shown).toMatchObject({ attached: true, state: 'shown', policy: 'background' })

		await browserPage.close()
		const detached = await waitFor(readVisibility, (status) => status.attached === false, { timeoutMs: 10_000, intervalMs: 150 })
		expect(detached).toMatchObject({ ok: true, attached: false, state: 'shown', policy: 'background' })

		browserPage = await fx.context.newPage()
		await browserPage.goto(site.origin)
		await decoyPage.bringToFront()
		await restoreForegroundApp(foregroundApp)
		const reattached = await waitFor(readVisibility, (status) => status.attached === true, { timeoutMs: 10_000, intervalMs: 150 })
		expect(reattached).toMatchObject({ ok: true, attached: true, state: 'shown', policy: 'background' })

		await browserPage.evaluate(() => {
			const state = globalThis as typeof globalThis & { __visibilityFrames: number }
			const tick = () => {
				state.__visibilityFrames += 1
				requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
		})
		const framesBefore = await evalValue<number>('globalThis.__visibilityFrames')
		await delay(250)
		expect(await evalValue<number>('globalThis.__visibilityFrames')).toBeGreaterThan(framesBefore)

		await assertBackground('reattach')
		await cliJson<VisibilityStatus>('page', 'hide', WATCHER_ID, '--policy', 'foreground', '--no-activate')
	})
})
