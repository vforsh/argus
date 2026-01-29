import { test, expect } from 'bun:test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { getFreePort } from './helpers/ports.js'
import { runCommand, runCommandWithExit, spawnAndWait } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const FIXTURE_WATCHER = path.resolve('e2e/fixtures/start-watcher.ts')

test('watcher + CLI e2e', async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-e2e-'))
	const env = { ...process.env, ARGUS_HOME: tempDir }
	const debugPort = await getFreePort()
	const watcherId = `e2e-watcher-${Date.now()}`

	// 1. Launch browser
	const browser = await chromium.launch({
		args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`],
	})

	try {
		const context = await browser.newContext()
		const page = await context.newPage()
		// Set title before navigating or staying on blank page
		await page.setContent('<html><head><title>argus-e2e</title></head><body><h1>E2E Page</h1></body></html>')

		// Verify title
		const title = await page.title()
		expect(title).toBe('argus-e2e')

		// 2. Start watcher
		const watcherConfig = {
			id: watcherId,
			chrome: { host: '127.0.0.1', port: debugPort },
			match: { title: 'argus-e2e' },
			host: '127.0.0.1',
			port: 0,
			net: { enabled: true },
		}

		const { proc: watcherProc, stdout: watcherStdout } = await spawnAndWait(
			'bun',
			[FIXTURE_WATCHER, JSON.stringify(watcherConfig)],
			{ env },
			/\{"id":"e2e-watcher-/,
		)

		try {
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
				} catch (error) {
					// ignore connection errors during startup
					void error
				}
				await new Promise((r) => setTimeout(r, 200))
			}
			expect(attached).toBe(true)

			// 4. Assert `argus list`
			const { stdout: listOut } = await runCommand('bun', [BIN_PATH, 'list'], { env })
			expect(listOut).toMatch(new RegExp(watcherId))
			expect(listOut).toMatch(/\[attached\]/)

			// 5. Emit log and assert `argus logs`
			const testMsg = `hello from e2e ${Date.now()}`
			const caseMsg = `CaseSensitiveToken-${Date.now()}`
			// Give it another moment to ensure Runtime.enable is active
			await new Promise((r) => setTimeout(r, 1000))
			await page.evaluate((msg) => console.log(msg), testMsg)
			await page.evaluate((msg) => console.log(msg), caseMsg)

			// Give it a moment to buffer
			await new Promise((r) => setTimeout(r, 1000))

			const { stdout: logsOut } = await runCommand('bun', [BIN_PATH, 'logs', watcherId, '--json'], { env })
			const logs = JSON.parse(logsOut) as Array<{ text: string }>
			expect(Array.isArray(logs)).toBe(true)
			expect(logs.some((l) => l.text === testMsg)).toBe(true)
			expect(logs.some((l) => l.text === caseMsg)).toBe(true)

			// 5b. Assert match/source filters
			const { stdout: matchOut } = await runCommand('bun', [BIN_PATH, 'logs', watcherId, '--json', '--match', 'nope', '--match', caseMsg], {
				env,
			})
			const matchLogs = JSON.parse(matchOut) as Array<{ text: string }>
			expect(matchLogs.some((l) => l.text === caseMsg)).toBe(true)

			const { stdout: caseSensitiveOut } = await runCommand(
				'bun',
				[BIN_PATH, 'logs', watcherId, '--json', '--match', caseMsg.toLowerCase(), '--case-sensitive'],
				{ env },
			)
			const caseSensitiveLogs = JSON.parse(caseSensitiveOut) as Array<{ text: string }>
			expect(caseSensitiveLogs.every((l) => l.text !== caseMsg)).toBe(true)

			const { stdout: ignoreCaseOut } = await runCommand(
				'bun',
				[BIN_PATH, 'logs', watcherId, '--json', '--match', caseMsg.toLowerCase(), '--ignore-case'],
				{ env },
			)
			const ignoreCaseLogs = JSON.parse(ignoreCaseOut) as Array<{ text: string }>
			expect(ignoreCaseLogs.some((l) => l.text === caseMsg)).toBe(true)

			const { stdout: sourceOut } = await runCommand('bun', [BIN_PATH, 'logs', watcherId, '--json', '--source', 'console'], {
				env,
			})
			const sourceLogs = JSON.parse(sourceOut) as Array<{ source: string; text: string }>
			expect(sourceLogs.some((l) => l.text === testMsg && l.source === 'console')).toBe(true)

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

			const { stdout: errorLogsOut } = await runCommand('bun', [BIN_PATH, 'logs', watcherId, '--json'], { env })
			const errorLogs = JSON.parse(errorLogsOut) as Array<{
				text: string
				level: string
				source: string
				args?: unknown[]
			}>

			const exceptionLogs = errorLogs.filter((event) => event.level === 'exception' && event.source === 'exception')
			expect(exceptionLogs.length > 0).toBe(true)
			expect(
				exceptionLogs.some((event) => event.text.includes(exceptionMarker) || JSON.stringify(event.args ?? []).includes(exceptionMarker)),
			).toBe(true)
			expect(
				exceptionLogs.some((event) => event.text.includes(rejectionMarker) || JSON.stringify(event.args ?? []).includes(rejectionMarker)),
			).toBe(true)

			const { stdout: exceptionSourceOut } = await runCommand('bun', [BIN_PATH, 'logs', watcherId, '--json', '--source', 'exception'], { env })
			const exceptionSourceLogs = JSON.parse(exceptionSourceOut) as Array<{ source: string; level: string }>
			expect(exceptionSourceLogs.every((event) => event.source === 'exception')).toBe(true)

			// 7. Eval CLI behaviors
			const {
				stdout: silentOut,
				stderr: silentErr,
				code: silentCode,
			} = await runCommandWithExit('bun', [BIN_PATH, 'eval', watcherId, '1+1', '--silent'], { env })
			expect(silentCode).toBe(0)
			expect(silentOut.trim()).toBe('')
			expect(silentErr.trim()).toBe('')

			const {
				stdout: failOut,
				stderr: failErr,
				code: failCode,
			} = await runCommandWithExit('bun', [BIN_PATH, 'eval', watcherId, 'throw new Error("e2e-fail")'], { env })
			expect(failCode).toBe(1)
			expect(failOut.trim()).toBe('')
			expect(failErr).toMatch(/Exception:/)

			const {
				stdout: noFailOut,
				stderr: noFailErr,
				code: noFailCode,
			} = await runCommandWithExit('bun', [BIN_PATH, 'eval', watcherId, 'throw new Error("e2e-no-fail")', '--no-fail-on-exception'], { env })
			expect(noFailCode).toBe(0)
			expect(noFailOut).toMatch(/Exception:/)
			expect(noFailErr.trim()).toBe('')

			const retryExpr =
				'globalThis.__argusEvalRetry = (globalThis.__argusEvalRetry ?? 0) + 1; if (globalThis.__argusEvalRetry < 2) { throw new Error("retry"); } "ok"'
			const {
				stdout: retryOut,
				stderr: retryErr,
				code: retryCode,
			} = await runCommandWithExit('bun', [BIN_PATH, 'eval', watcherId, retryExpr, '--retry', '1'], { env })
			expect(retryCode).toBe(0)
			expect(retryOut).toMatch(/ok/)
			expect(retryErr.trim()).toBe('')

			const countExpr = 'globalThis.__argusEvalCount = (globalThis.__argusEvalCount ?? 0) + 1; globalThis.__argusEvalCount'
			const { stdout: countOut, code: countCode } = await runCommandWithExit(
				'bun',
				[BIN_PATH, 'eval', watcherId, countExpr, '--interval', '50', '--count', '3'],
				{ env },
			)
			expect(countCode).toBe(0)
			const countLines = countOut
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
			expect(countLines.length).toBe(3)

			const untilExpr = 'globalThis.__argusEvalUntil = (globalThis.__argusEvalUntil ?? 0) + 1; globalThis.__argusEvalUntil'
			const { stdout: untilOut, code: untilCode } = await runCommandWithExit(
				'bun',
				[BIN_PATH, 'eval', watcherId, untilExpr, '--interval', '50', '--until', 'result >= 2'],
				{ env },
			)
			expect(untilCode).toBe(0)
			const untilLines = untilOut
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
			expect(untilLines.length).toBe(2)

			// 8. Assert `argus tail`
			const tailMsg = `tail message ${Date.now()}`

			const tailProcPromise = spawnAndWait('bun', [BIN_PATH, 'tail', watcherId, '--json'], { env }, new RegExp(tailMsg))

			// Give tail a moment to start long-polling
			await new Promise((r) => setTimeout(r, 1000))

			await page.evaluate((msg) => console.log(msg), tailMsg)

			const { proc: tailProc } = await tailProcPromise
			tailProc.kill('SIGINT')

			// 8. Assert top-level command aliases
			// 8a. `argus ls` should return the same output as `argus list`
			const { stdout: lsOut } = await runCommand('bun', [BIN_PATH, 'ls'], { env })
			expect(lsOut).toMatch(new RegExp(watcherId))
			expect(lsOut).toMatch(/\[attached\]/)

			// 8b. `argus log <id> --json` should behave like `argus logs <id> --json`
			const { stdout: logOut } = await runCommand('bun', [BIN_PATH, 'log', watcherId, '--json'], { env })
			const logLogs = JSON.parse(logOut) as Array<{ text: string }>
			expect(Array.isArray(logLogs)).toBe(true)

			// 8c. `argus network <id> --json` should behave like `argus net <id> --json`
			const { stdout: networkOut } = await runCommand('bun', [BIN_PATH, 'network', watcherId, '--json'], { env })
			const netResult = JSON.parse(networkOut) as unknown[]
			expect(Array.isArray(netResult)).toBe(true)

			// 8d. `argus browser status` should work like `argus chrome status`
			const { stdout: browserStatusOut } = await runCommand(
				'bun',
				[BIN_PATH, 'browser', 'status', '--host', '127.0.0.1', '--port', String(debugPort), '--json'],
				{ env },
			)
			const browserStatus = JSON.parse(browserStatusOut) as { Browser?: string }
			expect(browserStatus.Browser).toBeTruthy()
		} finally {
			watcherProc.kill('SIGTERM')
		}
	} finally {
		await browser.close()
		await fs.rm(tempDir, { recursive: true, force: true })
	}
})
