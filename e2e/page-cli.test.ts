import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import { chromium, type Browser } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, runCommandWithExit } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')

describe('page command e2e', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let browser: Browser
	let debugPort: number
	let cdpArgs: string[]

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-page-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir }
		debugPort = await getFreePort()

		browser = await chromium.launch({
			args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
		})

		const context = await browser.newContext()
		const page = await context.newPage()
		await page.setContent('<html><head><title>page-e2e</title></head><body><h1>Page E2E</h1></body></html>')

		cdpArgs = ['--host', '127.0.0.1', '--port', String(debugPort)]
	})

	afterAll(async () => {
		await browser?.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	test('page targets lists tabs', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(stdout) as Array<{ id: string; type: string; title: string }>
		expect(Array.isArray(targets)).toBe(true)
		expect(targets.some((t) => t.title === 'page-e2e')).toBe(true)
	})

	test('tab alias works for page targets', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'tab', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(stdout) as Array<{ id: string; type: string; title: string }>
		expect(targets.some((t) => t.title === 'page-e2e')).toBe(true)
	})

	test('page list/ls aliases work', async () => {
		const { stdout: listOut } = await runCommand('bun', [BIN_PATH, 'page', 'list', ...cdpArgs, '--json'], { env })
		const listTargets = JSON.parse(listOut) as Array<{ id: string }>
		expect(Array.isArray(listTargets)).toBe(true)

		const { stdout: lsOut } = await runCommand('bun', [BIN_PATH, 'page', 'ls', ...cdpArgs, '--json'], { env })
		const lsTargets = JSON.parse(lsOut) as Array<{ id: string }>
		expect(Array.isArray(lsTargets)).toBe(true)
	})

	test('page open creates new tab', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'page', 'open', '--url', 'about:blank', ...cdpArgs, '--json'], { env })
		const target = JSON.parse(stdout) as { id: string; url: string }
		expect(target.id).toBeTruthy()

		const { stdout: targetsOut } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string }>
		expect(targets.some((t) => t.id === target.id)).toBe(true)
	})

	test('page new alias works', async () => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'page', 'new', '--url', 'about:blank', ...cdpArgs, '--json'], { env })
		const target = JSON.parse(stdout) as { id: string }
		expect(target.id).toBeTruthy()
	})

	test('page activate focuses tab', async () => {
		const { stdout: targetsOut } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string }>
		expect(targets.length > 0).toBe(true)

		const targetId = targets[0].id
		const { stdout } = await runCommand('bun', [BIN_PATH, 'page', 'activate', targetId, ...cdpArgs, '--json'], { env })
		const result = JSON.parse(stdout) as { activated: string }
		expect(result.activated).toBe(targetId)
	})

	test('page reload reloads tab', async () => {
		const { stdout: targetsOut } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string; title: string }>
		const testPage = targets.find((t) => t.title === 'page-e2e')
		expect(testPage).toBeTruthy()

		const { stdout } = await runCommand('bun', [BIN_PATH, 'page', 'reload', testPage!.id, ...cdpArgs, '--json'], { env })
		const result = JSON.parse(stdout) as { reloaded: string }
		expect(result.reloaded).toBe(testPage!.id)
	})

	test('page reload --param updates query string', async () => {
		const httpPort = await getFreePort()
		const server = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end(`Query: ${req.url}`)
		})
		await new Promise<void>((resolve) => server.listen(httpPort, '127.0.0.1', resolve))

		try {
			const { stdout: openOut } = await runCommand(
				'bun',
				[BIN_PATH, 'page', 'open', '--url', `http://127.0.0.1:${httpPort}/test?initial=1`, ...cdpArgs, '--json'],
				{ env },
			)
			const newTarget = JSON.parse(openOut) as { id: string; url: string }
			expect(newTarget.id).toBeTruthy()
			expect(newTarget.url).toMatch(/initial=1/)

			await new Promise((r) => setTimeout(r, 500))

			const { stdout: reloadOut } = await runCommand(
				'bun',
				[BIN_PATH, 'page', 'reload', newTarget.id, '--param', 'foo=bar', '--param', 'baz=qux', ...cdpArgs, '--json'],
				{ env },
			)
			const reloadResult = JSON.parse(reloadOut) as { reloaded: string; url: string; previousUrl: string }
			expect(reloadResult.reloaded).toBe(newTarget.id)
			expect(reloadResult.url).toMatch(/foo=bar/)
			expect(reloadResult.url).toMatch(/baz=qux/)
			expect(reloadResult.url).toMatch(/initial=1/)
			expect(reloadResult.previousUrl).toBeTruthy()
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	test('page reload --params updates query string', async () => {
		const httpPort = await getFreePort()
		const server = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end(`Query: ${req.url}`)
		})
		await new Promise<void>((resolve) => server.listen(httpPort, '127.0.0.1', resolve))

		try {
			const { stdout: openOut } = await runCommand(
				'bun',
				[BIN_PATH, 'page', 'open', '--url', `http://127.0.0.1:${httpPort}/test`, ...cdpArgs, '--json'],
				{ env },
			)
			const newTarget = JSON.parse(openOut) as { id: string }

			await new Promise((r) => setTimeout(r, 500))

			const { stdout: reloadOut } = await runCommand(
				'bun',
				[BIN_PATH, 'page', 'reload', newTarget.id, '--params', 'a=1&b=2', ...cdpArgs, '--json'],
				{ env },
			)
			const reloadResult = JSON.parse(reloadOut) as { url: string }
			expect(reloadResult.url).toMatch(/a=1/)
			expect(reloadResult.url).toMatch(/b=2/)
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	test('page reload --param rejects non-http URLs', async () => {
		const { stdout: targetsOut } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string; url: string }>
		const blankPage = targets.find((t) => t.url === 'about:blank')
		expect(blankPage).toBeTruthy()

		const { stderr, code } = await runCommandWithExit('bun', [BIN_PATH, 'page', 'reload', blankPage!.id, '--param', 'foo=bar', ...cdpArgs], {
			env,
		})
		expect(code).toBe(2)
		expect(stderr).toMatch(/not http\/https/)
	})

	test('page reload --param rejects malformed param', async () => {
		const { stdout: targetsOut } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string; url: string }>
		const httpPage = targets.find((t) => t.url.startsWith('http'))
		expect(httpPage).toBeTruthy()

		const { stderr: noEqStderr, code: noEqCode } = await runCommandWithExit(
			'bun',
			[BIN_PATH, 'page', 'reload', httpPage!.id, '--param', 'noequals', ...cdpArgs],
			{ env },
		)
		expect(noEqCode).toBe(2)
		expect(noEqStderr).toMatch(/missing "="/)

		const { stderr: emptyKeyStderr, code: emptyKeyCode } = await runCommandWithExit(
			'bun',
			[BIN_PATH, 'page', 'reload', httpPage!.id, '--param', '=value', ...cdpArgs],
			{ env },
		)
		expect(emptyKeyCode).toBe(2)
		expect(emptyKeyStderr).toMatch(/empty key/)
	})

	test('page close closes tab', async () => {
		const { stdout: openOut } = await runCommand('bun', [BIN_PATH, 'page', 'open', '--url', 'about:blank', ...cdpArgs, '--json'], { env })
		const target = JSON.parse(openOut) as { id: string }

		const { stdout } = await runCommand('bun', [BIN_PATH, 'page', 'close', target.id, ...cdpArgs, '--json'], { env })
		const result = JSON.parse(stdout) as { closed: string }
		expect(result.closed).toBe(target.id)

		const { stdout: targetsOut } = await runCommand('bun', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string }>
		expect(targets.some((t) => t.id === target.id)).toBe(false)
	})
})
