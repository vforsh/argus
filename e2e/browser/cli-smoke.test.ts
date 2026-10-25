import { expect, setDefaultTimeout, test } from 'bun:test'
import type { DialogHandleResponse } from '@vforsh/argus-core'
import { delay } from '@vforsh/argus-core'
import { startCdpFixture } from '../helpers/browser.js'
import { createDialogProbe, holdNextDialog } from '../helpers/dialogs.js'
import { BIN_PATH } from '../helpers/paths.js'
import { waitFor } from '../helpers/poll.js'
import { spawnAndWait } from '../helpers/process.js'
import { TIMEOUTS } from '../helpers/timeouts.js'

setDefaultTimeout(TIMEOUTS.browser)

test('watcher + CLI e2e', async () => {
	const watcherId = `e2e-watcher-${Date.now()}`

	// 1. Launch browser, 2. start watcher, 3. wait for attachment
	const fx = await startCdpFixture({
		prefix: 'argus-e2e',
		watcher: { id: watcherId, match: { title: 'argus-e2e' }, net: { enabled: true } },
		preparePage: async (page) => {
			await page.goto('data:text/html,<html><head><title>argus-e2e</title></head><body><h1>E2E Page</h1></body></html>')

			// Verify title
			const title = await page.title()
			expect(title).toBe('argus-e2e')
		},
	})

	try {
		const { cli, page } = fx
		const { waitForDialog, waitForNoDialog } = createDialogProbe(cli, watcherId)

		const waitForDialogResult = (): Promise<string | boolean | null> =>
			waitFor(
				() =>
					page.evaluate(() => {
						const state = window as Window & { __dialogTestState?: { result: string | boolean | null } }
						return state.__dialogTestState?.result !== '__pending__' ? (state.__dialogTestState?.result ?? null) : null
					}),
				(result) => result !== null,
				{ timeoutMs: 5_000 },
			)

		const openDialog = (kind: 'alert' | 'confirm' | 'prompt', message: string, defaultPrompt = '') =>
			holdNextDialog(page, () =>
				page.evaluate(
					({ kind, message, defaultPrompt }) => {
						const state = window as Window & {
							__dialogTestState?: {
								kind: string
								message: string
								defaultPrompt: string
								result: string | boolean | null
								resolvedAt: number | null
							}
						}

						state.__dialogTestState = {
							kind,
							message,
							defaultPrompt,
							result: '__pending__',
							resolvedAt: null,
						}

						setTimeout(() => {
							if (kind === 'alert') {
								alert(message)
								state.__dialogTestState!.result = 'accepted'
							} else if (kind === 'confirm') {
								state.__dialogTestState!.result = confirm(message)
							} else {
								state.__dialogTestState!.result = prompt(message, defaultPrompt)
							}
							state.__dialogTestState!.resolvedAt = Date.now()
						}, 0)
					},
					{ kind, message, defaultPrompt },
				),
			)

		// 4. Assert `argus list`
		const { stdout: listOut } = await cli.run(['list'])
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

		const { stdout: logsOut } = await cli.run(['logs', watcherId, '--json'])
		const logs = JSON.parse(logsOut) as Array<{ text: string }>
		expect(Array.isArray(logs)).toBe(true)
		expect(logs.some((l) => l.text === testMsg)).toBe(true)
		expect(logs.some((l) => l.text === caseMsg)).toBe(true)

		// 5b. Assert match/source filters
		const { stdout: matchOut } = await cli.run(['logs', watcherId, '--json', '--match', 'nope', '--match', caseMsg])
		const matchLogs = JSON.parse(matchOut) as Array<{ text: string }>
		expect(matchLogs.some((l) => l.text === caseMsg)).toBe(true)

		const { stdout: caseSensitiveOut } = await cli.run(['logs', watcherId, '--json', '--match', caseMsg.toLowerCase(), '--case-sensitive'])
		const caseSensitiveLogs = JSON.parse(caseSensitiveOut) as Array<{ text: string }>
		expect(caseSensitiveLogs.every((l) => l.text !== caseMsg)).toBe(true)

		const { stdout: ignoreCaseOut } = await cli.run(['logs', watcherId, '--json', '--match', caseMsg.toLowerCase(), '--ignore-case'])
		const ignoreCaseLogs = JSON.parse(ignoreCaseOut) as Array<{ text: string }>
		expect(ignoreCaseLogs.some((l) => l.text === caseMsg)).toBe(true)

		const { stdout: sourceOut } = await cli.run(['logs', watcherId, '--json', '--source', 'console'])
		const sourceLogs = JSON.parse(sourceOut) as Array<{ source: string; text: string }>
		expect(sourceLogs.some((l) => l.text === testMsg && l.source === 'console')).toBe(true)

		const { stdout: cursorOut } = await cli.run(['logs', 'cursor', watcherId, '--json'])
		const cursor = (JSON.parse(cursorOut) as { cursor: string }).cursor
		const cursorMsg = `after-cursor-${Date.now()}`
		await page.evaluate((msg) => console.log(msg), cursorMsg)
		await delay(200)
		const { stdout: afterCursorOut } = await cli.run(['logs', watcherId, '--after', String(cursor), '--json'])
		const afterCursorLogs = JSON.parse(afterCursorOut) as Array<{ text: string }>
		expect(afterCursorLogs.some((event) => event.text === cursorMsg)).toBe(true)
		expect(afterCursorLogs.every((event) => event.text !== testMsg)).toBe(true)

		const { stdout: epochOut } = await cli.run(['logs', 'epoch', watcherId, '--json'])
		const epoch = (JSON.parse(epochOut) as { epoch: string }).epoch
		expect(typeof epoch).toBe('string')
		await page.reload()
		const duplicateMsg = `duplicate-epoch-${Date.now()}`
		await page.evaluate((msg) => {
			console.error(msg)
			console.error(msg)
		}, duplicateMsg)
		await delay(300)

		const { stdout: epochErrorsOut } = await cli.run(['logs', watcherId, '--since-epoch', epoch, '--levels', 'error', '--json'])
		const epochErrors = JSON.parse(epochErrorsOut) as Array<{ text: string }>
		expect(epochErrors.filter((event) => event.text === duplicateMsg)).toHaveLength(2)

		const { stdout: emptyEpochOut } = await cli.run(['logs', 'epoch', watcherId, '--json'])
		const emptyEpoch = (JSON.parse(emptyEpochOut) as { epoch: string }).epoch
		const { stdout: emptyDeltaOut } = await cli.run(['logs', watcherId, '--since-epoch', emptyEpoch, '--json'])
		expect(JSON.parse(emptyDeltaOut)).toEqual([])

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

		const { stdout: errorLogsOut } = await cli.run(['logs', watcherId, '--json'])
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

		const { stdout: exceptionSourceOut } = await cli.run(['logs', watcherId, '--json', '--source', 'exception'])
		const exceptionSourceLogs = JSON.parse(exceptionSourceOut) as Array<{ source: string; level: string }>
		expect(exceptionSourceLogs.every((event) => event.source === 'exception')).toBe(true)

		// 7. Eval CLI behaviors
		const { stdout: silentOut, stderr: silentErr, code: silentCode } = await cli.exec(['eval', watcherId, '1+1', '--silent'])
		expect(silentCode).toBe(0)
		expect(silentOut.trim()).toBe('')
		expect(silentErr.trim()).toBe('')

		const { stdout: jsAliasOut, stderr: jsAliasErr, code: jsAliasCode } = await cli.exec(['js', watcherId, '1+1'])
		expect(jsAliasCode).toBe(0)
		expect(jsAliasOut).toMatch(/\b2\b/)
		expect(jsAliasErr.trim()).toBe('')

		const { code: oldAliasCode, stderr: oldAliasErr } = await cli.exec(['e', watcherId, '1+1'])
		expect(oldAliasCode).not.toBe(0)
		expect(oldAliasErr).toMatch(/unknown command/i)

		const { stdout: failOut, stderr: failErr, code: failCode } = await cli.exec(['eval', watcherId, 'throw new Error("e2e-fail")'])
		expect(failCode).toBe(1)
		expect(failOut.trim()).toBe('')
		expect(failErr).toMatch(/Exception:/)

		const {
			stdout: noFailOut,
			stderr: noFailErr,
			code: noFailCode,
		} = await cli.exec(['eval', watcherId, 'throw new Error("e2e-no-fail")', '--no-fail-on-exception'])
		expect(noFailCode).toBe(0)
		expect(noFailOut).toMatch(/Exception:/)
		expect(noFailErr.trim()).toBe('')

		const retryExpr =
			'globalThis.__argusEvalRetry = (globalThis.__argusEvalRetry ?? 0) + 1; if (globalThis.__argusEvalRetry < 2) { throw new Error("retry"); } "ok"'
		const { stdout: retryOut, stderr: retryErr, code: retryCode } = await cli.exec(['eval', watcherId, retryExpr, '--retry', '1'])
		expect(retryCode).toBe(0)
		expect(retryOut).toMatch(/ok/)
		expect(retryErr.trim()).toBe('')

		const countExpr = 'globalThis.__argusEvalCount = (globalThis.__argusEvalCount ?? 0) + 1; globalThis.__argusEvalCount'
		const { stdout: countOut, code: countCode } = await cli.exec(['eval', watcherId, countExpr, '--interval', '50', '--count', '3'])
		expect(countCode).toBe(0)
		const countLines = countOut
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
		expect(countLines.length).toBe(3)

		const untilExpr = 'globalThis.__argusEvalUntil = (globalThis.__argusEvalUntil ?? 0) + 1; globalThis.__argusEvalUntil'
		const { stdout: untilOut, code: untilCode } = await cli.exec(['eval', watcherId, untilExpr, '--interval', '50', '--until', 'result >= 2'])
		expect(untilCode).toBe(0)
		const untilLines = untilOut
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
		expect(untilLines.length).toBe(2)

		// 8. Assert `argus logs tail`
		const tailMsg = `tail message ${Date.now()}`

		const tailProcPromise = spawnAndWait('bun', [BIN_PATH, 'logs', 'tail', watcherId, '--json'], { env: fx.env }, new RegExp(tailMsg))

		// Give tail a moment to start long-polling
		await new Promise((r) => setTimeout(r, 1000))

		await page.evaluate((msg) => console.log(msg), tailMsg)

		const { proc: tailProc } = await tailProcPromise
		tailProc.kill('SIGINT')

		// 8. Assert top-level command aliases
		// 8a. `argus ls` should return the same output as `argus list`
		const { stdout: lsOut } = await cli.run(['ls'])
		expect(lsOut).toMatch(new RegExp(watcherId))
		expect(lsOut).toMatch(/\[attached\]/)

		// 8b. `argus log <id> --json` should behave like `argus logs <id> --json`
		const { stdout: logOut } = await cli.run(['log', watcherId, '--json'])
		const logLogs = JSON.parse(logOut) as Array<{ text: string }>
		expect(Array.isArray(logLogs)).toBe(true)

		// 8c. `argus network <id> --json` should behave like `argus net <id> --json`
		const { stdout: networkOut } = await cli.run(['network', watcherId, '--json'])
		const netResult = JSON.parse(networkOut) as unknown[]
		expect(Array.isArray(netResult)).toBe(true)

		// 8d. `argus browser status` should work like `argus chrome status`
		const { stdout: browserStatusOut } = await cli.run(['browser', 'status', '--cdp', fx.cdpAddress, '--json'])
		const browserStatus = JSON.parse(browserStatusOut) as { Browser?: string }
		expect(browserStatus.Browser).toBeTruthy()

		// 9. Browser dialog support
		const alertMessage = `e2e-alert-${Date.now()}`
		const openedAlert = await openDialog('alert', alertMessage)
		expect(openedAlert.dialog.type).toBe('alert')
		expect(openedAlert.dialog.message).toBe(alertMessage)

		const alertStatus = await waitForDialog('alert')
		expect(alertStatus.message).toBe(alertMessage)

		const { stdout: alertHandleOut } = await cli.run(['dialog', 'accept', watcherId, '--json'])
		const alertHandle = JSON.parse(alertHandleOut) as DialogHandleResponse
		expect(alertHandle.action).toBe('accept')
		expect(alertHandle.dialog.type).toBe('alert')
		openedAlert.release()
		await waitForNoDialog()
		const alertResult = await waitForDialogResult()
		expect(alertResult).toBe('accepted')

		const confirmMessage = `e2e-confirm-${Date.now()}`
		const openedConfirm = await openDialog('confirm', confirmMessage)
		expect(openedConfirm.dialog.type).toBe('confirm')
		const confirmStatus = await waitForDialog('confirm')
		expect(confirmStatus.message).toBe(confirmMessage)

		await cli.run(['dialog', 'dismiss', watcherId])
		openedConfirm.release()
		await waitForNoDialog()
		const confirmResult = await waitForDialogResult()
		expect(confirmResult).toBe(false)

		const promptMessage = `e2e-prompt-${Date.now()}`
		const promptDefault = 'seed-value'
		const promptValue = 'updated-from-argus'
		const openedPrompt = await openDialog('prompt', promptMessage, promptDefault)
		expect(openedPrompt.dialog.type).toBe('prompt')
		expect(openedPrompt.dialog.defaultValue).toBe(promptDefault)

		const promptStatus = await waitForDialog('prompt')
		expect(promptStatus.message).toBe(promptMessage)
		expect(promptStatus.defaultPrompt).toBe(promptDefault)

		const { stdout: promptHandleOut } = await cli.run(['dialog', 'prompt', watcherId, '--text', promptValue, '--json'])
		const promptHandle = JSON.parse(promptHandleOut) as DialogHandleResponse
		expect(promptHandle.action).toBe('accept')
		expect(promptHandle.dialog.type).toBe('prompt')
		openedPrompt.release()
		await waitForNoDialog()
		const promptResult = await waitForDialogResult()
		expect(promptResult).toBe(promptValue)
	} finally {
		await fx.close()
	}
})
