import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, spawnAndWait } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

test('watcher + CLI e2e', async (t) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-e2e-'))
	const env = { ...process.env, ARGUS_HOME: tempDir }
	const debugPort = await getFreePort()
	const watcherId = `e2e-watcher-${Date.now()}`

	// 1. Launch browser
	const browser = await chromium.launch({
		args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
	})

	t.after(async () => {
		await browser.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const context = await browser.newContext()
	const page = await context.newPage()
	// Set title before navigating or staying on blank page
	await page.setContent('<html><head><title>argus-e2e</title></head><body><h1>E2E Page</h1></body></html>')

	// Verify title
	const title = await page.title()
	assert.equal(title, 'argus-e2e')

	// 2. Start watcher
	const watcherConfig = {
		id: watcherId,
		chrome: { host: '127.0.0.1', port: debugPort },
		match: { title: 'argus-e2e' },
		host: '127.0.0.1',
		port: 0,
	}

	const { proc: watcherProc, stdout: watcherStdout } = await spawnAndWait(
		'npx',
		['tsx', FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
		{ env },
		/\{"id":"e2e-watcher-/,
	)

	t.after(async () => {
		watcherProc.kill('SIGTERM')
	})

	const watcherInfo = JSON.parse(watcherStdout)

	// 3. Wait for attachment
	let attached = false
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${watcherInfo.port}/status`)
			const status = (await res.json()) as { attached: boolean }
			if (status.attached) {
				attached = true
				break
			}
		} catch (e) {
			// ignore connection errors during startup
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	assert.ok(attached, 'Watcher should be attached to page')

	// 4. Assert `argus list`
	const { stdout: listOut } = await runCommand('node', [BIN_PATH, 'list'], { env })
	assert.match(listOut, new RegExp(watcherId))
	assert.match(listOut, /\[attached\]/)

	// 5. Emit log and assert `argus logs`
	const testMsg = `hello from e2e ${Date.now()}`
	const caseMsg = `CaseSensitiveToken-${Date.now()}`
	// Give it another moment to ensure Runtime.enable is active
	await new Promise((r) => setTimeout(r, 1000))
	await page.evaluate((msg) => console.log(msg), testMsg)
	await page.evaluate((msg) => console.log(msg), caseMsg)

	// Give it a moment to buffer
	await new Promise((r) => setTimeout(r, 1000))

	const { stdout: logsOut } = await runCommand('node', [BIN_PATH, 'logs', watcherId, '--json'], { env })
	const logs = JSON.parse(logsOut) as Array<{ text: string }>
	assert.ok(Array.isArray(logs), 'Logs should be a JSON array')
	assert.ok(
		logs.some((l) => l.text === testMsg),
		`Logs should contain "${testMsg}"`,
	)
	assert.ok(
		logs.some((l) => l.text === caseMsg),
		`Logs should contain "${caseMsg}"`,
	)

	// 5b. Assert match/source filters
	const { stdout: matchOut } = await runCommand(
		'node',
		[BIN_PATH, 'logs', watcherId, '--json', '--match', 'nope', '--match', caseMsg],
		{ env },
	)
	const matchLogs = JSON.parse(matchOut) as Array<{ text: string }>
	assert.ok(matchLogs.some((l) => l.text === caseMsg), 'Expected OR match to include case message')

	const { stdout: caseSensitiveOut } = await runCommand(
		'node',
		[BIN_PATH, 'logs', watcherId, '--json', '--match', caseMsg.toLowerCase(), '--case-sensitive'],
		{ env },
	)
	const caseSensitiveLogs = JSON.parse(caseSensitiveOut) as Array<{ text: string }>
	assert.ok(
		caseSensitiveLogs.every((l) => l.text !== caseMsg),
		'Case-sensitive match should not include case message for lower-case pattern',
	)

	const { stdout: ignoreCaseOut } = await runCommand(
		'node',
		[BIN_PATH, 'logs', watcherId, '--json', '--match', caseMsg.toLowerCase(), '--ignore-case'],
		{ env },
	)
	const ignoreCaseLogs = JSON.parse(ignoreCaseOut) as Array<{ text: string }>
	assert.ok(
		ignoreCaseLogs.some((l) => l.text === caseMsg),
		'Ignore-case match should include case message',
	)

	const { stdout: sourceOut } = await runCommand('node', [BIN_PATH, 'logs', watcherId, '--json', '--source', 'console'], {
		env,
	})
	const sourceLogs = JSON.parse(sourceOut) as Array<{ source: string; text: string }>
	assert.ok(sourceLogs.some((l) => l.text === testMsg && l.source === 'console'), 'Expected console source filter to include log')

	// 6. Emit page errors and assert `argus logs`
	const exceptionMarker = `e2e-uncaught-${Date.now()}`
	const rejectionMarker = `e2e-rejection-${Date.now()}`

	await page.evaluate(
		({ exceptionMarker, rejectionMarker }) => {
			setTimeout(() => {
				throw new Error(exceptionMarker)
			}, 0)
			Promise.reject(new Error(rejectionMarker))
		},
		{ exceptionMarker, rejectionMarker },
	)

	await new Promise((r) => setTimeout(r, 1500))

	const { stdout: errorLogsOut } = await runCommand('node', [BIN_PATH, 'logs', watcherId, '--json'], { env })
	const errorLogs = JSON.parse(errorLogsOut) as Array<{
		text: string
		level: string
		source: string
		args?: unknown[]
	}>

	const exceptionLogs = errorLogs.filter((event) => event.level === 'exception' && event.source === 'exception')
	assert.ok(exceptionLogs.length > 0, 'Expected exception logs in watcher output')
	assert.ok(
		exceptionLogs.some((event) => event.text.includes(exceptionMarker) || JSON.stringify(event.args ?? []).includes(exceptionMarker)),
		`Expected uncaught exception marker "${exceptionMarker}" in logs`,
	)
	assert.ok(
		exceptionLogs.some((event) => event.text.includes(rejectionMarker) || JSON.stringify(event.args ?? []).includes(rejectionMarker)),
		`Expected unhandled rejection marker "${rejectionMarker}" in logs`,
	)

	const { stdout: exceptionSourceOut } = await runCommand(
		'node',
		[BIN_PATH, 'logs', watcherId, '--json', '--source', 'exception'],
		{ env },
	)
	const exceptionSourceLogs = JSON.parse(exceptionSourceOut) as Array<{ source: string; level: string }>
	assert.ok(
		exceptionSourceLogs.every((event) => event.source === 'exception'),
		'Expected exception source filter to exclude non-exception events',
	)

	// 7. Assert `argus tail`
	const tailMsg = `tail message ${Date.now()}`

	const tailProcPromise = spawnAndWait('node', [BIN_PATH, 'tail', watcherId, '--json'], { env }, new RegExp(tailMsg))

	// Give tail a moment to start long-polling
	await new Promise((r) => setTimeout(r, 1000))

	await page.evaluate((msg) => console.log(msg), tailMsg)

	const { proc: tailProc } = await tailProcPromise
	tailProc.kill('SIGINT')
})
