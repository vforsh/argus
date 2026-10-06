import type { ChildProcess } from 'node:child_process'
import { sendCdpCommand } from '../../cdp/sendCdpCommand.js'

/**
 * Build idempotent cleanup for one launched Chrome.
 * @param chrome The exact child process owned by this launcher.
 * @param browserWebSocketUrl Its confirmed browser endpoint; undefined skips CDP and terminates the child directly.
 * @param cleanupDir Removes only this launcher's temporary profile.
 * @returns Immediate cleanup and graceful close; graceful close waits for process exit before removing the profile.
 */
export const createChromeCleanup = (
	chrome: ChildProcess,
	browserWebSocketUrl: string | undefined,
	cleanupDir: () => void,
): { cleanup: () => void; closeGracefully: () => Promise<void> } => {
	let closing: Promise<void> | undefined
	chrome.on('exit', cleanupDir)

	const cleanup = () => {
		chrome.kill()
		cleanupDir()
	}
	const close = async () => {
		if (!hasExited(chrome)) {
			await closeChrome(chrome, browserWebSocketUrl)
		}
		cleanupDir()
	}
	return { cleanup, closeGracefully: () => (closing ??= close()) }
}

const closeChrome = async (chrome: ChildProcess, browserWebSocketUrl: string | undefined): Promise<void> => {
	try {
		if (browserWebSocketUrl) await sendCdpCommand(browserWebSocketUrl, { id: 1, method: 'Browser.close' }, 3_000)
	} catch {
		// A dead CDP endpoint still leaves us the exact child process to terminate.
	}
	if (await waitForExit(chrome, 3_000)) return
	chrome.kill('SIGTERM')
	if (await waitForExit(chrome, 1_000)) return
	chrome.kill('SIGKILL')
	if (!(await waitForExit(chrome, 1_000))) throw new Error(`Chrome ${chrome.pid} did not exit after SIGKILL.`)
}

const hasExited = (chrome: ChildProcess): boolean => chrome.exitCode !== null || chrome.signalCode !== null

const waitForExit = (chrome: ChildProcess, timeoutMs: number): Promise<boolean> => {
	if (hasExited(chrome)) return Promise.resolve(true)
	return new Promise((resolve) => {
		const finish = (exited: boolean) => {
			clearTimeout(timer)
			chrome.off('exit', onExit)
			resolve(exited)
		}
		const onExit = () => finish(true)
		const timer = setTimeout(() => finish(false), timeoutMs)
		chrome.once('exit', onExit)
	})
}
