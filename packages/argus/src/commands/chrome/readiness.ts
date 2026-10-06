import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { delay, formatError } from '@vforsh/argus-core'
import { fetchJson } from '../../httpClient.js'
import type { ChromeVersionResponse } from './shared.js'

/**
 * Wait for a launched browser's CDP endpoint, rejecting after 5s or process exit.
 * @param chrome Browser child whose exit invalidates startup.
 * @param endpoint Requested host/port; port 0 is resolved and verified against the private DevToolsActivePort file.
 * @param userDataDir Isolated profile directory for this launch.
 * @returns Actual port and browser metadata, including the confirmed browser WebSocket URL.
 */
export const waitForLaunchedChrome = async (
	chrome: ChildProcess,
	endpoint: { host: string; port: number },
	userDataDir: string,
): Promise<{ port: number; version: ChromeVersionResponse }> => {
	const deadline = Date.now() + 5_000
	let lastError = 'Timed out waiting for CDP.'
	while (Date.now() < deadline) {
		if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error('Chrome exited before CDP became reachable.')
		try {
			let port = endpoint.port
			let browserPath: string | undefined
			if (port === 0) {
				const lines = (await readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
				port = Number(lines[0])
				browserPath = lines[1]
				if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath?.startsWith('/devtools/browser/')) {
					throw new Error('Chrome has not published a valid DevToolsActivePort yet.')
				}
			}
			const version = await fetchJson<ChromeVersionResponse>(`http://${endpoint.host}:${port}/json/version`, { timeoutMs: 500 })
			if (!version.Browser || !version.webSocketDebuggerUrl) throw new Error('Chrome responded without its browser CDP endpoint.')
			if (browserPath && new URL(version.webSocketDebuggerUrl).pathname !== browserPath) {
				throw new Error('CDP endpoint does not belong to the launched Chrome.')
			}
			return { port, version }
		} catch (error) {
			lastError = formatError(error)
		}
		await delay(150)
	}
	throw new Error(lastError)
}
