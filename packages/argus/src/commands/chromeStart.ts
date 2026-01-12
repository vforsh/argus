import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadRegistry, pruneRegistry } from '../registry.js'
import { resolveChromeBin } from '../utils/chromeBin.js'
import { getCdpPort } from '../utils/ports.js'

export type ChromeStartOptions = {
	url?: string
	id?: string
	json?: boolean
	defaultProfile?: boolean
}

type ChromeStartResult = {
	chromePid: number
	cdpHost: string
	cdpPort: number
	userDataDir: string | null
	startupUrl: string | null
}

export const runChromeStart = async (options: ChromeStartOptions): Promise<void> => {
	if (options.url && options.id) {
		console.error('Cannot combine --url with --id. Use one or the other.')
		process.exitCode = 2
		return
	}

	let startupUrl: string | null = null

	if (options.id) {
		const registry = await pruneRegistry(await loadRegistry())
		const watcher = registry.watchers[options.id]
		if (!watcher) {
			console.error(`Watcher not found: ${options.id}`)
			process.exitCode = 1
			return
		}
		if (!watcher.match?.url) {
			console.error(`Watcher "${options.id}" has no match.url configured.`)
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
		console.error('Chrome executable not found. Set ARGUS_CHROME_BIN environment variable.')
		process.exitCode = 1
		return
	}

	const cdpPort = await getCdpPort()
	const cdpHost = '127.0.0.1'
	const userDataDir = options.defaultProfile ? null : mkdtempSync(path.join(tmpdir(), 'argus-chrome-'))

	const args = [`--remote-debugging-port=${cdpPort}`]
	if (userDataDir) {
		args.push(`--user-data-dir=${userDataDir}`)
		args.push('--no-first-run')
		args.push('--no-default-browser-check')
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
		console.error(`Failed to spawn Chrome: ${error instanceof Error ? error.message : error}`)
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true })
		}
		process.exitCode = 1
		return
	}

	if (!chrome.pid) {
		console.error('Failed to start Chrome: no PID returned.')
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
		process.stdout.write(JSON.stringify(result) + '\n')
	} else {
		console.log(`Chrome started:`)
		console.log(`  pid=${result.chromePid}`)
		console.log(`  cdp=${result.cdpHost}:${result.cdpPort}`)
		console.log(`  userDataDir=${result.userDataDir}`)
		if (result.startupUrl) {
			console.log(`  url=${result.startupUrl}`)
		}
	}

	await new Promise(() => {})
}
