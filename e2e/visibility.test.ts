import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import type { DomKeydownResponse, EvalResponse, VisibilityResponse } from '@vforsh/argus-core'
import { readForegroundApp, restoreForegroundApp } from './helpers/foreground.js'
import { delay } from '@vforsh/argus-core'
import { getFreePort } from './helpers/ports.js'
import { runCommand, runCommandWithExit, spawnAndWait, stopProcess } from './helpers/process.js'
import { waitForWatcherPortAttached } from './helpers/watcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')
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
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let context: Awaited<ReturnType<Browser['newContext']>>
	let browserPage: Page
	let decoyPage: Page
	let foregroundApp: string | null = null
	let watcherProc: ChildProcess
	let watcherPort: number
	let site: http.Server
	let origin: string

	const runArgus = (...args: string[]) => runCommand('node', [BIN_PATH, ...args], { env })

	const cliJson = async <T = Record<string, unknown>>(...args: string[]): Promise<T> => {
		const { stdout } = await runArgus(...args, '--json')
		return JSON.parse(stdout) as T
	}

	const evalValue = async <T = unknown>(expression: string): Promise<T> => {
		const response = await cliJson<EvalResponse>('eval', WATCHER_ID, expression)
		expect(response.ok).toBe(true)
		return response.result as T
	}

	const readVisibility = (): Promise<VisibilityStatus> => cliJson<VisibilityStatus>('page', 'visibility', WATCHER_ID)

	const waitFor = async <T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
		const deadline = Date.now() + timeoutMs
		let value: T
		do {
			value = await read()
			if (predicate(value)) return value
			await delay(150)
		} while (Date.now() < deadline)
		throw new Error(`Timed out after ${timeoutMs}ms; last value: ${JSON.stringify(value!)}`)
	}

	const assertBackground = async (phase: string): Promise<void> => {
		const app = await readForegroundApp()
		if (foregroundApp) expect(app).toBe(foregroundApp)
		expect(await decoyPage.evaluate(() => document.visibilityState)).toBe('visible')
		console.info('[visibility-cdp evidence]', JSON.stringify({ phase, app, decoyVisible: true }))
	}

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-visibility-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const sitePort = await getFreePort()
		origin = `http://127.0.0.1:${sitePort}`
		site = http.createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'text/html' })
			response.end(pageHtml)
		})
		await new Promise<void>((resolve) => site.listen(sitePort, '127.0.0.1', resolve))

		const debugPort = await getFreePort()
		foregroundApp = await readForegroundApp()
		browser = await chromium.launch({
			headless: process.env.ARGUS_E2E_HEADED !== '1',
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})
		context = await browser.newContext()
		browserPage = await context.newPage()
		await browserPage.goto(origin)

		const watcherConfig = {
			id: WATCHER_ID,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { origin: `127.0.0.1:${sitePort}` },
			host: '127.0.0.1',
			port: 0,
		}
		const { proc, stdout } = await spawnAndWait('bun', [FIXTURE_WATCHER, JSON.stringify(watcherConfig)], { env }, /\{"id":"visibility-cdp"/)
		watcherProc = proc
		watcherPort = (JSON.parse(stdout) as { port: number }).port
		await waitForWatcherPortAttached(watcherPort)
		decoyPage = await context.newPage()
		await decoyPage.goto('about:blank')
		await decoyPage.bringToFront()
		await restoreForegroundApp(foregroundApp)
	})

	afterAll(async () => {
		if (watcherProc) await stopProcess(watcherProc)
		await browser?.close()
		await new Promise<void>((resolve) => {
			if (!site) return resolve()
			site.close(() => resolve())
		})
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
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
			const result = await runCommandWithExit('node', [BIN_PATH, ...command, WATCHER_ID, '--json'], { env })
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
		const detached = await waitFor(readVisibility, (status) => status.attached === false)
		expect(detached).toMatchObject({ ok: true, attached: false, state: 'shown', policy: 'background' })

		browserPage = await context.newPage()
		await browserPage.goto(origin)
		await decoyPage.bringToFront()
		await restoreForegroundApp(foregroundApp)
		const reattached = await waitFor(readVisibility, (status) => status.attached === true)
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
