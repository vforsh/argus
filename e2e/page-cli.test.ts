import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import { chromium } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, runCommandWithExit } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')

test('page command e2e', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-page-e2e-'))
	const env = { ...process.env, ARGUS_HOME: tempDir }
	const debugPort = await getFreePort()

	const browser = await chromium.launch({
		args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
	})

	t.after(async () => {
		await browser.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const context = await browser.newContext()
	const page = await context.newPage()
	await page.setContent('<html><head><title>page-e2e</title></head><body><h1>Page E2E</h1></body></html>')

	const cdpArgs = ['--host', '127.0.0.1', '--port', String(debugPort)]

	await t.test('page targets lists tabs', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(stdout) as Array<{ id: string; type: string; title: string }>
		assert.ok(Array.isArray(targets), 'Targets should be a JSON array')
		assert.ok(targets.some((t) => t.title === 'page-e2e'), 'Should find the test page')
	})

	await t.test('tab alias works for page targets', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'tab', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(stdout) as Array<{ id: string; type: string; title: string }>
		assert.ok(targets.some((t) => t.title === 'page-e2e'), 'tab alias should find the test page')
	})

	await t.test('page list/ls aliases work', async () => {
		const { stdout: listOut } = await runCommand('node', [BIN_PATH, 'page', 'list', ...cdpArgs, '--json'], { env })
		const listTargets = JSON.parse(listOut) as Array<{ id: string }>
		assert.ok(Array.isArray(listTargets), 'page list should return targets')

		const { stdout: lsOut } = await runCommand('node', [BIN_PATH, 'page', 'ls', ...cdpArgs, '--json'], { env })
		const lsTargets = JSON.parse(lsOut) as Array<{ id: string }>
		assert.ok(Array.isArray(lsTargets), 'page ls should return targets')
	})

	await t.test('page open creates new tab', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'page', 'open', '--url', 'about:blank', ...cdpArgs, '--json'], { env })
		const target = JSON.parse(stdout) as { id: string; url: string }
		assert.ok(target.id, 'New tab should have an id')

		const { stdout: targetsOut } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string }>
		assert.ok(
			targets.some((t) => t.id === target.id),
			'New tab should appear in targets list',
		)
	})

	await t.test('page new alias works', async () => {
		const { stdout } = await runCommand('node', [BIN_PATH, 'page', 'new', '--url', 'about:blank', ...cdpArgs, '--json'], { env })
		const target = JSON.parse(stdout) as { id: string }
		assert.ok(target.id, 'page new alias should create a tab')
	})

	await t.test('page activate focuses tab', async () => {
		const { stdout: targetsOut } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string }>
		assert.ok(targets.length > 0, 'Should have at least one page target')

		const targetId = targets[0].id
		const { stdout } = await runCommand('node', [BIN_PATH, 'page', 'activate', targetId, ...cdpArgs, '--json'], { env })
		const result = JSON.parse(stdout) as { activated: string }
		assert.equal(result.activated, targetId, 'Should activate the correct target')
	})

	await t.test('page reload reloads tab', async () => {
		const { stdout: targetsOut } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string; title: string }>
		const testPage = targets.find((t) => t.title === 'page-e2e')
		assert.ok(testPage, 'Should find test page')

		const { stdout } = await runCommand('node', [BIN_PATH, 'page', 'reload', testPage.id, ...cdpArgs, '--json'], { env })
		const result = JSON.parse(stdout) as { reloaded: string }
		assert.equal(result.reloaded, testPage.id, 'Should reload the correct target')
	})

	await t.test('page reload --param updates query string', async () => {
		const httpPort = await getFreePort()
		const server = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end(`Query: ${req.url}`)
		})
		await new Promise<void>((resolve) => server.listen(httpPort, '127.0.0.1', resolve))

		t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

		const { stdout: openOut } = await runCommand(
			'node',
			[BIN_PATH, 'page', 'open', '--url', `http://127.0.0.1:${httpPort}/test?initial=1`, ...cdpArgs, '--json'],
			{ env },
		)
		const newTarget = JSON.parse(openOut) as { id: string; url: string }
		assert.ok(newTarget.id, 'Should open new page')
		assert.match(newTarget.url, /initial=1/, 'Initial URL should have query param')

		await new Promise((r) => setTimeout(r, 500))

		const { stdout: reloadOut } = await runCommand(
			'node',
			[BIN_PATH, 'page', 'reload', newTarget.id, '--param', 'foo=bar', '--param', 'baz=qux', ...cdpArgs, '--json'],
			{ env },
		)
		const reloadResult = JSON.parse(reloadOut) as { reloaded: string; url: string; previousUrl: string }
		assert.equal(reloadResult.reloaded, newTarget.id, 'Should reload the correct target')
		assert.match(reloadResult.url, /foo=bar/, 'URL should contain foo=bar')
		assert.match(reloadResult.url, /baz=qux/, 'URL should contain baz=qux')
		assert.match(reloadResult.url, /initial=1/, 'URL should preserve initial param')
		assert.ok(reloadResult.previousUrl, 'Should include previousUrl')
	})

	await t.test('page reload --params updates query string', async () => {
		const httpPort = await getFreePort()
		const server = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' })
			res.end(`Query: ${req.url}`)
		})
		await new Promise<void>((resolve) => server.listen(httpPort, '127.0.0.1', resolve))

		t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

		const { stdout: openOut } = await runCommand(
			'node',
			[BIN_PATH, 'page', 'open', '--url', `http://127.0.0.1:${httpPort}/test`, ...cdpArgs, '--json'],
			{ env },
		)
		const newTarget = JSON.parse(openOut) as { id: string }

		await new Promise((r) => setTimeout(r, 500))

		const { stdout: reloadOut } = await runCommand(
			'node',
			[BIN_PATH, 'page', 'reload', newTarget.id, '--params', 'a=1&b=2', ...cdpArgs, '--json'],
			{ env },
		)
		const reloadResult = JSON.parse(reloadOut) as { url: string }
		assert.match(reloadResult.url, /a=1/, 'URL should contain a=1')
		assert.match(reloadResult.url, /b=2/, 'URL should contain b=2')
	})

	await t.test('page reload --param rejects non-http URLs', async () => {
		const { stdout: targetsOut } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string; url: string }>
		const blankPage = targets.find((t) => t.url === 'about:blank')
		assert.ok(blankPage, 'Should find about:blank page')

		const { stderr, code } = await runCommandWithExit(
			'node',
			[BIN_PATH, 'page', 'reload', blankPage.id, '--param', 'foo=bar', ...cdpArgs],
			{ env },
		)
		assert.equal(code, 2, 'Should exit with code 2 for non-http URL')
		assert.match(stderr, /not http\/https/, 'Should show error about non-http URL')
	})

	await t.test('page reload --param rejects malformed param', async () => {
		const { stdout: targetsOut } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json', '--type', 'page'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string; url: string }>
		const httpPage = targets.find((t) => t.url.startsWith('http'))
		assert.ok(httpPage, 'Should find http page')

		const { stderr: noEqStderr, code: noEqCode } = await runCommandWithExit(
			'node',
			[BIN_PATH, 'page', 'reload', httpPage.id, '--param', 'noequals', ...cdpArgs],
			{ env },
		)
		assert.equal(noEqCode, 2, 'Should exit with code 2 for missing =')
		assert.match(noEqStderr, /missing "="/, 'Should show error about missing =')

		const { stderr: emptyKeyStderr, code: emptyKeyCode } = await runCommandWithExit(
			'node',
			[BIN_PATH, 'page', 'reload', httpPage.id, '--param', '=value', ...cdpArgs],
			{ env },
		)
		assert.equal(emptyKeyCode, 2, 'Should exit with code 2 for empty key')
		assert.match(emptyKeyStderr, /empty key/, 'Should show error about empty key')
	})

	await t.test('page close closes tab', async () => {
		const { stdout: openOut } = await runCommand('node', [BIN_PATH, 'page', 'open', '--url', 'about:blank', ...cdpArgs, '--json'], { env })
		const target = JSON.parse(openOut) as { id: string }

		const { stdout } = await runCommand('node', [BIN_PATH, 'page', 'close', target.id, ...cdpArgs, '--json'], { env })
		const result = JSON.parse(stdout) as { closed: string }
		assert.equal(result.closed, target.id, 'Should close the correct target')

		const { stdout: targetsOut } = await runCommand('node', [BIN_PATH, 'page', 'targets', ...cdpArgs, '--json'], { env })
		const targets = JSON.parse(targetsOut) as Array<{ id: string }>
		assert.ok(
			!targets.some((t) => t.id === target.id),
			'Closed tab should not appear in targets list',
		)
	})
})
