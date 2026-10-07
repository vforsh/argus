import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { spawnAndWait, stopProcess } from './helpers/process.js'
import { startSession, type SessionHarness } from './helpers/session.js'
import { waitForWatcherPortAttached } from './helpers/watcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

/** Short enough that a dialog parked behind its own trigger would fail the test, not just slow it. */
const REQUEST_TIMEOUT_MS = 15_000

const TEST_HTML = `
<!DOCTYPE html>
<html>
<head><title>session-dialog-e2e</title></head>
<body>
  <button id="confirm" onclick="window.__confirmed = window.confirm('click-confirm')">Confirm</button>
</body>
</html>
`

type Line = Awaited<ReturnType<SessionHarness['next']>>

describe('dialog controls over the persistent session transport', () => {
	let tempDir: string
	let env: NodeJS.ProcessEnv
	let browser: Browser
	let page: Page
	let watcherProc: ChildProcess
	let session: SessionHarness
	const watcherId = `session-dialog-${Date.now()}`

	/** Collect `count` responses keyed by id, in the order the session wrote them. */
	const collect = async (count: number): Promise<{ order: unknown[]; byId: Map<unknown, Line> }> => {
		const order: unknown[] = []
		const byId = new Map<unknown, Line>()
		for (let i = 0; i < count; i++) {
			const line = await session.next()
			order.push(line.id)
			byId.set(line.id, line)
		}
		return { order, byId }
	}

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-session-dialog-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		const debugPort = await getFreePort()

		browser = await chromium.launch({ args: ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`] })
		page = await (await browser.newContext()).newPage()
		// Playwright auto-dismisses dialogs nobody listens for; a no-op listener leaves them to Argus.
		page.on('dialog', () => {})
		await page.setContent(TEST_HTML)

		const watcherConfig = { id: watcherId, chrome: { host: '127.0.0.1', port: debugPort }, match: { title: 'session-dialog-e2e' }, host: '127.0.0.1', port: 0 }
		const { proc, stdout } = await spawnAndWait('bun', [FIXTURE_WATCHER, JSON.stringify(watcherConfig)], { env }, /\{"id":"session-dialog-/)
		watcherProc = proc
		await waitForWatcherPortAttached(JSON.parse(stdout).port)

		session = startSession(BIN_PATH, [watcherId, '--request-timeout', `${REQUEST_TIMEOUT_MS}ms`], { env, cwd: tempDir })
		expect(await session.next()).toMatchObject({ type: 'ready', watcher: { id: watcherId } })
	})

	afterAll(async () => {
		await session?.close(5_000)
		await stopProcess(watcherProc)
		await browser?.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	test('status and accept reach a confirm opened by an in-flight eval', async () => {
		session.send({ id: 'eval', cmd: 'eval', args: { expression: "window.confirm('eval-confirm')" } })
		session.send({ id: 'status', cmd: 'dialog status' })
		session.send({ id: 'accept', cmd: 'dialog accept' })

		const { order, byId } = await collect(3)
		expect(order).toEqual(['status', 'accept', 'eval'])
		expect(byId.get('status')).toMatchObject({ ok: true, result: { ok: true, dialog: { type: 'confirm', message: 'eval-confirm' } } })
		expect(byId.get('accept')).toMatchObject({ ok: true, result: { ok: true, action: 'accept' } })
		expect(byId.get('eval')).toMatchObject({ ok: true, result: { ok: true, result: true } })
		expect(byId.get('eval')!.durationMs as number).toBeLessThan(REQUEST_TIMEOUT_MS)
	})

	test('dismiss reaches a confirm opened by an in-flight click', async () => {
		session.send({ id: 'click', cmd: 'click', args: { selector: '#confirm' } })
		session.send({ id: 'dismiss', cmd: 'dialog dismiss' })
		session.send({ id: 'after', cmd: 'eval', args: { expression: 'window.__confirmed' } })

		const { order, byId } = await collect(3)
		expect(order).toEqual(['dismiss', 'click', 'after'])
		expect(byId.get('dismiss')).toMatchObject({ ok: true, result: { ok: true, action: 'dismiss', dialog: { message: 'click-confirm' } } })
		expect(byId.get('click')).toMatchObject({ ok: true })
		expect(byId.get('after')).toMatchObject({ ok: true, result: { result: false } })
	})

	test('prompt answers a prompt opened by an in-flight eval', async () => {
		session.send({ id: 'eval', cmd: 'eval', args: { expression: "window.prompt('name?', 'default')" } })
		session.send({ id: 'prompt', cmd: 'dialog prompt', args: { text: 'argus' } })

		const { order, byId } = await collect(2)
		expect(order).toEqual(['prompt', 'eval'])
		expect(byId.get('eval')).toMatchObject({ ok: true, result: { result: 'argus' } })
	})

	test('controls keep submission order when nothing blocks on a dialog', async () => {
		session.send({ id: 'slow', cmd: 'eval', args: { expression: 'new Promise((resolve) => setTimeout(() => resolve(1), 300))' } })
		session.send({ id: 'status', cmd: 'dialog status' })
		session.send({ id: 'accept', cmd: 'dialog accept' })
		session.send({ id: 'ping', cmd: 'ping' })

		const { order, byId } = await collect(4)
		expect(order).toEqual(['slow', 'status', 'accept', 'ping'])
		expect(byId.get('status')).toMatchObject({ ok: true, result: { ok: true, dialog: null } })
		// A failed control reports its own exit code and leaves the session serving.
		expect(byId.get('accept')).toMatchObject({ ok: false, exitCode: 1 })
		expect(byId.get('ping')).toMatchObject({ ok: true, result: { pong: true } })
	})
})
