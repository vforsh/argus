import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatError } from '../../cli/parse.js'
import { buildChromeLaunchArgs } from './launchArgs.js'
import { waitForLaunchedChrome } from './readiness.js'
import { createChromeCleanup } from './lifecycle.js'

const REGULAR_CHROME_USER_AGENT = 'regular-chrome'

/** Resolve the startup option to the exact value passed to Chrome's `--user-agent` flag. */
export const resolveChromeUserAgent = async (chromeBin: string, requested?: string): Promise<string | null> => {
	if (requested === undefined) {
		return null
	}
	if (!requested.trim()) {
		throw new Error('Invalid --user-agent value. Use regular-chrome or a non-empty literal user agent.')
	}
	if (requested !== REGULAR_CHROME_USER_AGENT) {
		return requested
	}

	const defaultUserAgent = await probeHeadlessChromeUserAgent(chromeBin)
	return toRegularChromeUserAgent(defaultUserAgent)
}

/** Preserve Chrome's generated UA verbatim except for the headless product marker. */
export const toRegularChromeUserAgent = (userAgent: string): string => userAgent.replace('HeadlessChrome/', 'Chrome/')

const probeHeadlessChromeUserAgent = async (chromeBin: string): Promise<string> => {
	const userDataDir = mkdtempSync(path.join(tmpdir(), 'argus-chrome-ua-'))
	const args = buildChromeLaunchArgs({ cdpPort: 0, userDataDir, headless: true, launchUrl: null })
	let chrome: ChildProcess | null = null
	let browserWebSocketUrl: string | undefined

	try {
		chrome = spawn(chromeBin, args, { stdio: 'ignore', detached: false })
		if (!chrome.pid) {
			throw new Error('Failed to start Chrome user-agent probe: no PID returned.')
		}

		const { version } = await waitForLaunchedChrome(chrome, { host: '127.0.0.1', port: 0 }, userDataDir)
		browserWebSocketUrl = version.webSocketDebuggerUrl
		if (!version['User-Agent']) {
			throw new Error('Chrome user-agent probe returned no User-Agent.')
		}
		return version['User-Agent']
	} catch (error) {
		throw new Error(`Failed to derive regular Chrome user agent: ${formatError(error)}`)
	} finally {
		const cleanupDir = () => rmSync(userDataDir, { recursive: true, force: true })
		if (chrome?.pid) await createChromeCleanup(chrome, browserWebSocketUrl, cleanupDir).closeGracefully()
		else cleanupDir()
	}
}
