import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { delay } from '@vforsh/argus-core'
import { sendCdpCommand } from '../../cdp/sendCdpCommand.js'
import { formatError } from '../../cli/parse.js'
import { fetchJson } from '../../httpClient.js'
import { getCdpPort } from '../../utils/ports.js'
import { buildChromeLaunchArgs } from './launchArgs.js'
import type { ChromeVersionResponse } from './shared.js'

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
	const cdpPort = await getCdpPort()
	const args = buildChromeLaunchArgs({ cdpPort, userDataDir, headless: true, launchUrl: null })
	let chrome: ChildProcess | null = null

	try {
		chrome = spawn(chromeBin, args, { stdio: 'ignore', detached: false })
		if (!chrome.pid) {
			throw new Error('Failed to start Chrome user-agent probe: no PID returned.')
		}

		const version = await waitForChromeVersion(cdpPort, chrome)
		if (!version['User-Agent']) {
			throw new Error('Chrome user-agent probe returned no User-Agent.')
		}
		return version['User-Agent']
	} catch (error) {
		throw new Error(`Failed to derive regular Chrome user agent: ${formatError(error)}`)
	} finally {
		await closeProbe(chrome, cdpPort)
		rmSync(userDataDir, { recursive: true, force: true })
	}
}

const waitForChromeVersion = async (port: number, chrome: ChildProcess): Promise<ChromeVersionResponse> => {
	const deadline = Date.now() + 5_000
	let lastError = 'Timed out waiting for Chrome.'

	while (Date.now() < deadline) {
		if (chrome.exitCode !== null) {
			throw new Error('Chrome exited before the user-agent probe became reachable.')
		}
		try {
			return await fetchJson<ChromeVersionResponse>(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 500 })
		} catch (error) {
			lastError = formatError(error)
		}
		await delay(150)
	}

	throw new Error(lastError)
}

const closeProbe = async (chrome: ChildProcess | null, port: number): Promise<void> => {
	if (!chrome || chrome.exitCode !== null) {
		return
	}

	try {
		const version = await fetchJson<ChromeVersionResponse>(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 500 })
		await sendCdpCommand(version.webSocketDebuggerUrl, { id: 1, method: 'Browser.close' }, 1_000)
	} catch {
		chrome.kill()
	}

	if (chrome.exitCode === null) {
		await Promise.race([
			new Promise<void>((resolve) => chrome.once('exit', () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
		])
	}
	if (chrome.exitCode === null) {
		chrome.kill()
	}
}
