import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fetchJson } from '../httpClient.js'
import { loadRegistry, pruneRegistry } from '../registry.js'
import { createOutput } from '../output/io.js'
import { resolveChromeBin } from '../utils/chromeBin.js'
import { getCdpPort } from '../utils/ports.js'
import type { ChromeVersionResponse } from './chrome.js'
import type { ChromeTargetResponse } from '../cdp/types.js'

export type ChromeStartOptions = {
	url?: string
	id?: string
	json?: boolean
	defaultProfile?: boolean
	devTools?: boolean
	devToolsPanel?: string
}

type ChromeStartResult = {
	chromePid: number
	cdpHost: string
	cdpPort: number
	userDataDir: string | null
	startupUrl: string | null
}

type ChromeStartReadyResult = {
	ready: true
	version: string
}

type ChromeStartNotReadyResult = {
	ready: false
	error: string
}

type ChromeStartReadyCheck = ChromeStartReadyResult | ChromeStartNotReadyResult

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const resolveChromeUserDataDir = (): string | null => {
	if (process.env.ARGUS_CHROME_USER_DATA_DIR) {
		const override = process.env.ARGUS_CHROME_USER_DATA_DIR.trim()
		if (override && existsSync(override)) {
			return override
		}
	}

	const platform = process.platform
	if (platform === 'darwin') {
		const candidates = [
			path.join(homedir(), 'Library/Application Support/Google/Chrome'),
			path.join(homedir(), 'Library/Application Support/Chromium'),
		]
		return candidates.find((candidate) => existsSync(candidate)) ?? null
	}

	if (platform === 'linux') {
		const candidates = [path.join(homedir(), '.config/google-chrome'), path.join(homedir(), '.config/chromium')]
		return candidates.find((candidate) => existsSync(candidate)) ?? null
	}

	if (platform === 'win32') {
		const base = process.env.LOCALAPPDATA
		if (!base) {
			return null
		}
		const candidates = [path.join(base, 'Google/Chrome/User Data'), path.join(base, 'Chromium/User Data')]
		return candidates.find((candidate) => existsSync(candidate)) ?? null
	}

	return null
}

const copyDefaultProfile = (sourceDir: string): string => {
	const destRoot = mkdtempSync(path.join(tmpdir(), 'argus-chrome-profile-'))
	mkdirSync(destRoot, { recursive: true })

	const entries = ['Default', 'Local State', 'First Run', 'Last Version']
	for (const entry of entries) {
		const source = path.join(sourceDir, entry)
		if (!existsSync(source)) {
			continue
		}
		const dest = path.join(destRoot, entry)
		if (entry === 'Default') {
			cpSync(source, dest, { recursive: true })
		} else {
			copyFileSync(source, dest)
		}
	}

	return destRoot
}

const waitForCdpReady = async (host: string, port: number, chrome: ChildProcess): Promise<ChromeStartReadyCheck> => {
	const deadline = Date.now() + 5_000
	const url = `http://${host}:${port}/json/version`
	let lastError: string | null = null

	while (Date.now() < deadline) {
		if (chrome.exitCode !== null) {
			return { ready: false, error: 'Chrome exited before CDP became reachable.' }
		}

		try {
			const response = await fetchJson<ChromeVersionResponse>(url, { timeoutMs: 500 })
			if (response.Browser) {
				return { ready: true, version: response.Browser }
			}
			lastError = 'Chrome responded without Browser version.'
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}

		await delay(150)
	}

	return { ready: false, error: lastError ?? 'Timed out waiting for CDP.' }
}

const normalizeDevToolsPanel = (panel?: string): string | null => {
	if (!panel) {
		return null
	}
	const trimmed = panel.trim()
	if (!trimmed) {
		return null
	}
	return trimmed
}

const loadPageTargets = async (host: string, port: number): Promise<ChromeTargetResponse[]> => {
	const url = `http://${host}:${port}/json/list`
	const targets = await fetchJson<ChromeTargetResponse[]>(url)
	return targets.filter((target) => target.type === 'page')
}

const selectDevToolsTarget = (targets: ChromeTargetResponse[], startupUrl: string | null): ChromeTargetResponse | null => {
	if (targets.length === 0) {
		return null
	}
	if (startupUrl) {
		const match = targets.find((target) => target.url === startupUrl)
		if (match) {
			return match
		}
	}
	return targets[0] ?? null
}

const buildDevToolsUrl = (panel: string, target: ChromeTargetResponse): string | null => {
	if (!target.webSocketDebuggerUrl) {
		return null
	}
	const wsUrl = new URL(target.webSocketDebuggerUrl)
	const wsParam = `${wsUrl.host}${wsUrl.pathname}`
	return `chrome-devtools://devtools/bundled/devtools_app.html?panel=${encodeURIComponent(panel)}&ws=${wsParam}`
}

const openDevToolsPanel = async (
	host: string,
	port: number,
	panel: string,
	startupUrl: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> => {
	let targets: ChromeTargetResponse[]
	try {
		targets = await loadPageTargets(host, port)
	} catch (error) {
		return {
			ok: false,
			error: `Failed to load targets for DevTools: ${error instanceof Error ? error.message : error}`,
		}
	}

	const target = selectDevToolsTarget(targets, startupUrl)
	if (!target) {
		return { ok: false, error: 'No page targets available for DevTools.' }
	}

	const devToolsUrl = buildDevToolsUrl(panel, target)
	if (!devToolsUrl) {
		return { ok: false, error: `Target ${target.id} has no webSocketDebuggerUrl.` }
	}

	const encodedUrl = encodeURIComponent(devToolsUrl)
	const url = `http://${host}:${port}/json/new?${encodedUrl}`
	try {
		await fetchJson<ChromeTargetResponse>(url, { method: 'PUT' })
		return { ok: true }
	} catch (error) {
		return {
			ok: false,
			error: `Failed to open DevTools panel: ${error instanceof Error ? error.message : error}`,
		}
	}
}

export const runChromeStart = async (options: ChromeStartOptions): Promise<void> => {
	const output = createOutput(options)
	if (options.url && options.id) {
		output.writeWarn('Cannot combine --url with --id. Use one or the other.')
		process.exitCode = 2
		return
	}

	let startupUrl: string | null = null

	if (options.id) {
		const registry = await pruneRegistry(await loadRegistry())
		const watcher = registry.watchers[options.id]
		if (!watcher) {
			output.writeWarn(`Watcher not found: ${options.id}`)
			process.exitCode = 1
			return
		}
		if (!watcher.match?.url) {
			output.writeWarn(`Watcher "${options.id}" has no match.url configured.`)
			process.exitCode = 2
			return
		}
		startupUrl = watcher.match.url
		if (!startupUrl.startsWith('http://') && !startupUrl.startsWith('https://')) {
			startupUrl = `http://${startupUrl}`
		}
	} else if (options.url) {
		startupUrl = options.url
	}

	const chromeBin = resolveChromeBin()
	if (!chromeBin) {
		output.writeWarn('Chrome executable not found. Set ARGUS_CHROME_BIN environment variable.')
		process.exitCode = 1
		return
	}

	let userDataDir: string | null = null
	if (options.defaultProfile) {
		const sourceDir = resolveChromeUserDataDir()
		if (!sourceDir) {
			output.writeWarn('Chrome user data dir not found. Set ARGUS_CHROME_USER_DATA_DIR.')
			process.exitCode = 1
			return
		}
		try {
			userDataDir = copyDefaultProfile(sourceDir)
		} catch (error) {
			output.writeWarn(`Failed to copy default Chrome profile: ${error instanceof Error ? error.message : error}`)
			process.exitCode = 1
			return
		}
	}

	const cdpPort = await getCdpPort()
	const cdpHost = '127.0.0.1'
	if (!userDataDir) {
		userDataDir = mkdtempSync(path.join(tmpdir(), 'argus-chrome-'))
	}

	const args = [`--remote-debugging-port=${cdpPort}`]
	if (userDataDir) {
		args.push(`--user-data-dir=${userDataDir}`)
		args.push('--no-first-run')
		args.push('--no-default-browser-check')
	}
	if (options.devTools) {
		args.push('--auto-open-devtools-for-tabs')
	}
	if (startupUrl) {
		args.push(startupUrl)
	}

	let chrome: ChildProcess
	try {
		chrome = spawn(chromeBin, args, {
			stdio: 'ignore',
			detached: false,
		})
	} catch (error) {
		output.writeWarn(`Failed to spawn Chrome: ${error instanceof Error ? error.message : error}`)
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true })
		}
		process.exitCode = 1
		return
	}

	if (!chrome.pid) {
		output.writeWarn('Failed to start Chrome: no PID returned.')
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true })
		}
		process.exitCode = 1
		return
	}

	const result: ChromeStartResult = {
		chromePid: chrome.pid,
		cdpHost,
		cdpPort,
		userDataDir,
		startupUrl,
	}

	const ready = await waitForCdpReady(cdpHost, cdpPort, chrome)
	if (!ready.ready) {
		output.writeWarn(`Chrome started but CDP is unavailable at ${cdpHost}:${cdpPort}.`)
		output.writeWarn(`Reason: ${ready.error}`)
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
		try {
			chrome.kill()
		} catch {}
		process.exitCode = 1
		return
	}

	const devToolsPanel = normalizeDevToolsPanel(options.devToolsPanel)
	if (devToolsPanel) {
		const opened = await openDevToolsPanel(cdpHost, cdpPort, devToolsPanel, startupUrl)
		if (!opened.ok) {
			output.writeWarn(opened.error)
		}
	}

	const cleanup = () => {
		try {
			chrome.kill()
		} catch {}
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
	}

	process.on('SIGINT', () => {
		cleanup()
		process.exit(0)
	})
	process.on('SIGTERM', () => {
		cleanup()
		process.exit(0)
	})

	chrome.on('exit', () => {
		if (userDataDir) {
			try {
				rmSync(userDataDir, { recursive: true, force: true })
			} catch {}
		}
		process.exit(0)
	})

	if (options.json) {
		output.writeJson(result)
	} else {
		output.writeHuman(`Chrome started:`)
		output.writeHuman(`  pid=${result.chromePid}`)
		output.writeHuman(`  cdp=${result.cdpHost}:${result.cdpPort}`)
		output.writeHuman(`  userDataDir=${result.userDataDir}`)
		if (result.startupUrl) {
			output.writeHuman(`  url=${result.startupUrl}`)
		}
	}

	await new Promise(() => {})
}
