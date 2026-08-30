/**
 * Live-extension e2e harness: real Chromium, the unpacked Argus extension, real native
 * messaging hosts — everything isolated inside one temp directory.
 *
 * Isolation model, verified empirically on macOS (see tasks/c2-frame-snapshot.md):
 * - Chromium resolves user-level native messaging manifests under the active
 *   `--user-data-dir`, so manifests written to `<profile>/NativeMessagingHosts` are picked
 *   up while the real Chrome profile stays untouched.
 * - Chrome spawns hosts without a shell profile, so `ARGUS_HOME`/`ARGUS_REGISTRY_PATH`
 *   are baked into the wrapper scripts; every watcher the run creates lands in the temp
 *   registry, and the `cli()` helper talks to that same registry.
 * - Branded Google Chrome 137+ ignores `--load-extension`; the harness requires a
 *   Chrome for Testing / Chromium binary (ARGUS_E2E_CHROME_BIN, or auto-discovered from
 *   the Playwright browser cache) and skips the suite when none is available.
 * - `--use-mock-keychain` is mandatory on macOS: without it Chrome for Testing blocks on
 *   a Keychain prompt before the profile is even created.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { delay } from '@vforsh/argus-core'
import { ARGUS_EXTENSION_ID, installNativeHostsTo } from '@vforsh/argus/internal'
import { startPlaygroundServers } from '../../playground/harness.ts'
import { getFreePort } from './ports.js'
import { runCommandWithExit, type CommandResultWithExit } from './process.js'

const REPO_ROOT = path.resolve(import.meta.dirname!, '..', '..')
const BIN_PATH = path.join(REPO_ROOT, 'packages', 'argus', 'dist', 'bin.js')
const EXTENSION_DIR = path.join(REPO_ROOT, 'packages', 'argus-extension')

const CONTROL_WATCHER_ID = 'extension-control'
const STARTUP_TIMEOUT_MS = 60_000

export type ExtensionHarness = {
	/** URL the harness Chrome opened (playground index on the main server). */
	pageUrl: string
	/** Origin of the cross-origin iframe server. */
	crossOriginUrl: string
	/** `127.0.0.1:<port>` of the main server — the substring `ext use --url` matches on. */
	pageUrlSubstring: string
	/** Run the repo CLI against the harness's isolated registry. */
	cli: (...args: string[]) => Promise<CommandResultWithExit>
	/** Run the CLI and parse stdout as JSON, failing loudly with the full output when it isn't. */
	cliJson: <T>(...args: string[]) => Promise<T>
	close: () => Promise<void>
}

/**
 * Locate a Chromium/Chrome for Testing binary that still honors `--load-extension`.
 * Returns null when none is found; suites gate themselves on this instead of failing.
 */
export const resolveTestChromeBin = (): string | null => {
	const explicit = process.env.ARGUS_E2E_CHROME_BIN?.trim()
	if (explicit) {
		return fs.existsSync(explicit) ? explicit : null
	}

	const cacheRoot =
		process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright')
	if (!fs.existsSync(cacheRoot)) {
		return null
	}

	const chromiumDirs = fs
		.readdirSync(cacheRoot)
		.filter((name) => /^chromium-\d+$/.test(name))
		.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))

	const relativeCandidates = [
		'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
		'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
		'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
		'chrome-linux/chrome',
	]
	for (const dir of chromiumDirs) {
		for (const candidate of relativeCandidates) {
			const bin = path.join(cacheRoot, dir, candidate)
			if (fs.existsSync(bin)) {
				return bin
			}
		}
	}
	return null
}

export const startExtensionHarness = async (): Promise<ExtensionHarness> => {
	const chromeBin = resolveTestChromeBin()
	if (!chromeBin) {
		throw new Error('No Chromium/Chrome for Testing binary found. Set ARGUS_E2E_CHROME_BIN or install Playwright browsers.')
	}
	assertBuildArtifacts()

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ext-e2e-'))
	const argusHome = path.join(tempRoot, 'argus-home')
	const registryPath = path.join(argusHome, 'registry.json')
	const userDataDir = path.join(tempRoot, 'profile')
	fs.mkdirSync(argusHome, { recursive: true })
	fs.mkdirSync(userDataDir, { recursive: true })

	const isolationEnv = { ARGUS_HOME: argusHome, ARGUS_REGISTRY_PATH: registryPath }
	installNativeHostsTo(path.join(userDataDir, 'NativeMessagingHosts'), ARGUS_EXTENSION_ID, BIN_PATH, {
		env: isolationEnv,
		nodePath: resolveNodeBin(),
	})

	const mainPort = await getFreePort()
	const crossOriginPort = await getFreePort()
	const webSocketPort = await getFreePort()
	const servers = startPlaygroundServers({ port: mainPort, crossOriginPort, webSocketPort })

	const chrome = spawnChrome(chromeBin, userDataDir, servers.mainUrl)

	const cli = (...args: string[]): Promise<CommandResultWithExit> =>
		runCommandWithExit(resolveNodeBin(), [BIN_PATH, ...args], { env: { ...process.env, ...isolationEnv } })

	const cliJson = async <T>(...args: string[]): Promise<T> => {
		const result = await cli(...args)
		try {
			return JSON.parse(result.stdout) as T
		} catch {
			throw new Error(
				`CLI output is not JSON for \`argus ${args.join(' ')}\` (exit ${result.code}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
			)
		}
	}

	const close = async (): Promise<void> => {
		chrome.kill('SIGKILL')
		await waitForExit(chrome, 3_000)
		// Native hosts exit when Chrome closes their stdio; give them a beat before wiping state.
		await delay(500)
		await servers.close()
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}

	try {
		await waitForControlWatcher(registryPath, chrome)
	} catch (error) {
		await close()
		throw error
	}

	return {
		pageUrl: servers.mainUrl,
		crossOriginUrl: servers.crossOriginUrl,
		pageUrlSubstring: `127.0.0.1:${mainPort}`,
		cli,
		cliJson,
		close,
	}
}

const assertBuildArtifacts = (): void => {
	const required = [
		{ file: BIN_PATH, fix: 'npm run build:packages' },
		{ file: path.join(EXTENSION_DIR, 'dist', 'background', 'service-worker.js'), fix: 'bun run --cwd packages/argus-extension build' },
		{ file: path.join(EXTENSION_DIR, 'manifest.json'), fix: 'checkout is broken: extension manifest is missing' },
	]
	for (const { file, fix } of required) {
		if (!fs.existsSync(file)) {
			throw new Error(`Missing build artifact ${file}. Run: ${fix}`)
		}
	}
}

/** The harness runs under bun, but native hosts and the CLI should run under node like production. */
const resolveNodeBin = (): string => {
	const fromEnv = process.env.ARGUS_E2E_NODE_BIN?.trim()
	if (fromEnv) {
		return fromEnv
	}
	const which = execSync('which node', { encoding: 'utf8' }).trim()
	if (!which) {
		throw new Error('node not found in PATH; the extension harness needs it to run native hosts')
	}
	return which
}

const spawnChrome = (chromeBin: string, userDataDir: string, startupUrl: string): ChildProcess => {
	const headed = process.env.ARGUS_E2E_HEADED === '1'
	const args = [
		`--user-data-dir=${userDataDir}`,
		`--load-extension=${EXTENSION_DIR}`,
		`--disable-extensions-except=${EXTENSION_DIR}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-timer-throttling',
		'--use-mock-keychain',
		'--password-store=basic',
		...(headed ? [] : ['--headless=new']),
		startupUrl,
	]
	return spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

/**
 * The control host registers its watcher after its HTTP server is listening, so a registry
 * entry doubles as a readiness signal for the whole chain: extension loaded, service worker
 * ran, native host spawned, watcher HTTP up.
 */
const waitForControlWatcher = (registryPath: string, chrome: ChildProcess): Promise<void> => {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS
	let chromeError: Error | null = null
	let stderrTail = ''
	chrome.stderr?.on('data', (chunk: Buffer) => {
		stderrTail = (stderrTail + String(chunk)).slice(-2000)
	})
	chrome.once('exit', (code) => {
		chromeError = new Error(`Chrome exited during startup (code ${code}).\nstderr tail:\n${stderrTail}`)
	})

	return (async () => {
		while (Date.now() < deadline) {
			if (chromeError) {
				throw chromeError
			}
			if (fs.existsSync(registryPath)) {
				try {
					const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { watchers?: Record<string, unknown> }
					if (registry.watchers?.[CONTROL_WATCHER_ID]) {
						return
					}
				} catch {
					// Registry mid-write; retry.
				}
			}
			await delay(250)
		}
		throw new Error(`extension-control watcher did not register within ${STARTUP_TIMEOUT_MS}ms.\nChrome stderr tail:\n${stderrTail}`)
	})()
}

const waitForExit = (proc: ChildProcess, timeoutMs: number): Promise<void> =>
	new Promise((resolve) => {
		if (proc.exitCode != null) {
			resolve()
			return
		}
		const timer = setTimeout(resolve, timeoutMs)
		proc.once('exit', () => {
			clearTimeout(timer)
			resolve()
		})
	})
