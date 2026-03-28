import { execFile } from 'node:child_process'
import type { ChromeTargetResponse } from '../../cdp/types.js'
import { fetchJson } from '../../httpClient.js'
import { createOutput } from '../../output/io.js'
import type { ChromeVersionResponse } from './shared.js'

export type ChromeListOptions = { json?: boolean; pages?: boolean }

export type ChromeInstanceInfo = {
	port: number
	pid: number
	browser: string
	webSocketDebuggerUrl: string
	targets: number
	pages: number
	pageDetails?: Array<{ title: string; url: string }>
}

/** Discover reachable Chrome instances with CDP enabled. */
export const discoverChromeInstances = async (options?: { pages?: boolean }): Promise<ChromeInstanceInfo[]> => {
	const ports = await discoverChromeCdpPorts()
	if (ports.length === 0) return []

	const results = await Promise.all(
		ports.map(async ({ port, pid }) => {
			try {
				const [version, targets] = await Promise.all([
					fetchJson<ChromeVersionResponse>(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 2_000 }),
					fetchJson<ChromeTargetResponse[]>(`http://127.0.0.1:${port}/json/list`, { timeoutMs: 2_000 }),
				])
				const userPages = targets.filter((t) => t.type === 'page' && isUserPage(t.url))
				return {
					port,
					pid,
					reachable: true as const,
					browser: version.Browser,
					webSocketDebuggerUrl: version.webSocketDebuggerUrl,
					targets: targets.length,
					pages: userPages.length,
					...(options?.pages && { pageDetails: userPages.map((p) => ({ title: p.title, url: p.url })) }),
				}
			} catch {
				return { port, pid, reachable: false as const }
			}
		}),
	)

	return results.filter((result): result is Extract<typeof result, { reachable: true }> => result.reachable)
}

/** Format a Chrome instance as a human-readable line. */
export const formatChromeInstanceLine = (result: ChromeInstanceInfo): string =>
	`127.0.0.1:${result.port} pid=${result.pid} ${result.browser} ${result.pages} page${result.pages === 1 ? '' : 's'}`

export const runChromeList = async (options: ChromeListOptions): Promise<void> => {
	const output = createOutput(options)
	const ports = await discoverChromeCdpPorts()
	if (ports.length === 0) {
		output.writeHuman('No Chrome instances found listening on TCP ports.')
		return
	}

	const instances = await discoverChromeInstances(options)
	if (instances.length === 0) {
		output.writeHuman('Found Chrome processes listening on TCP, but none responded to CDP.')
		return
	}

	if (options.json) {
		output.writeJson(instances)
		return
	}

	for (const result of instances) {
		output.writeHuman(formatChromeInstanceLine(result))
		if (!result.pageDetails) {
			continue
		}

		for (const page of result.pageDetails) {
			output.writeHuman(`  ${page.title} — ${page.url}`)
		}
	}
}

/**
 * Chrome-internal URLs that CDP reports as `type: "page"` but are not user-visible tabs.
 * Covers omnibox popups, NTP sub-frames, side panels, and other top-chrome UI surfaces.
 */
const CHROME_INTERNAL_URL_PATTERN = /^(devtools|chrome-untrusted):\/\/|\.top-chrome\/|^chrome:\/\/newtab-footer\b/

const isUserPage = (url: string): boolean => !CHROME_INTERNAL_URL_PATTERN.test(url)

/**
 * Match Chrome/Chromium process names in lsof output.
 * With `+c 0`, macOS lsof escapes spaces as `\x20` (e.g. `Google\x20Chrome`).
 */
const CHROME_NAME_PATTERN = /\b(google(\s|\\x20)*chrome|chromium|chrome)\b/i

const discoverChromeCdpPorts = async (): Promise<Array<{ port: number; pid: number }>> => {
	let stdout: string
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			execFile('lsof', ['+c', '0', '-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: 5_000 }, (error, out) => {
				if (error) {
					reject(error)
					return
				}
				resolve(out)
			})
		})
	} catch {
		return []
	}

	const seen = new Set<number>()
	const results: Array<{ port: number; pid: number }> = []

	for (const line of stdout.split('\n')) {
		if (!CHROME_NAME_PATTERN.test(line)) {
			continue
		}

		const pidMatch = line.match(/\s+(\d+)\s+/)
		if (!pidMatch) {
			continue
		}

		const pid = parseInt(pidMatch[1], 10)
		if (isNaN(pid)) {
			continue
		}

		const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)
		if (!portMatch) {
			continue
		}

		const port = parseInt(portMatch[1], 10)
		if (isNaN(port) || seen.has(port)) {
			continue
		}

		seen.add(port)
		results.push({ port, pid })
	}

	return results
}
