/**
 * Real-browser setup shared by the CDP suites: Playwright's Chromium with a debugging port, a watcher
 * started through the SDK fixture, and an isolated `ARGUS_HOME` for the CLI that drives it.
 */
import type { ChildProcess } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright'
import { argusEnv, createCli, type Cli } from './cli.js'
import { FIXTURE_WATCHER_PATH } from './paths.js'
import { getFreePort } from './ports.js'
import { spawnAndWait, stopProcess } from './process.js'
import { makeTempDir, removeDir } from './tempDir.js'
import { waitForWatcherPortAttached } from './watcher.js'

export type DebuggableBrowser = {
	browser: Browser
	debugPort: number
	/** `127.0.0.1:<debugPort>`, the form `--cdp` takes. */
	cdpAddress: string
}

/** Launch Chromium with its CDP endpoint on a free loopback port. */
export const launchDebuggableBrowser = async (options: LaunchOptions = {}): Promise<DebuggableBrowser> => {
	const debugPort = await getFreePort()
	const browser = await chromium.launch({
		...options,
		args: ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, ...(options.args ?? [])],
	})
	return { browser, debugPort, cdpAddress: `127.0.0.1:${debugPort}` }
}

export type FixtureWatcher = { id: string; host: string; port: number; proc: ChildProcess }

/**
 * Start a watcher in a child process through `fixtures/start-watcher.ts`, passing `config` verbatim.
 *
 * The fixture prints its record before it has attached, so this waits for attachment unless
 * `waitForAttach` is false (registry suites point at a closed CDP port on purpose).
 */
export const startFixtureWatcher = async (
	config: Record<string, unknown>,
	{ env, waitForAttach = true }: { env: NodeJS.ProcessEnv; waitForAttach?: boolean },
): Promise<FixtureWatcher> => {
	const { proc, stdout } = await spawnAndWait('bun', [FIXTURE_WATCHER_PATH, JSON.stringify(config)], { env }, /\{"id":/)
	const record = JSON.parse(stdout.trim().split('\n')[0]!) as Omit<FixtureWatcher, 'proc'>
	try {
		if (waitForAttach) await waitForWatcherPortAttached(record.port)
	} catch (error) {
		await stopProcess(proc)
		throw error
	}
	return { ...record, proc }
}

export type CdpFixture = DebuggableBrowser & {
	home: string
	env: NodeJS.ProcessEnv
	/** The built CLI bound to `env`. */
	cli: Cli
	context: BrowserContext
	page: Page
	watcher: FixtureWatcher
	/** Stop the watcher, close the browser, then remove the temp home. */
	close: () => Promise<void>
}

export type CdpFixtureOptions = {
	/** Temp `ARGUS_HOME` prefix. */
	prefix: string
	/** Watcher config: `id` and `match` at least. Chrome, host and port are filled in. */
	watcher: { id: string } & Record<string, unknown>
	/** Navigate or seed the page before the watcher starts; the watcher matches what this leaves. */
	preparePage: (page: Page) => Promise<unknown>
	/** Interpreter for `cli`. Defaults to Bun. */
	runtime?: 'bun' | 'node'
	launch?: LaunchOptions
}

/** Browser, page and attached watcher for one suite, torn down by `close()`; cleans up after itself if setup fails. */
export const startCdpFixture = async ({ prefix, watcher: watcherConfig, preparePage, runtime, launch }: CdpFixtureOptions): Promise<CdpFixture> => {
	const home = await makeTempDir(prefix)
	const env = argusEnv(home)
	let debuggable: DebuggableBrowser | undefined
	try {
		debuggable = await launchDebuggableBrowser(launch)
		const context = await debuggable.browser.newContext()
		const page = await context.newPage()
		await preparePage(page)
		const watcher = await startFixtureWatcher(
			{ chrome: { host: '127.0.0.1', port: debuggable.debugPort }, host: '127.0.0.1', port: 0, ...watcherConfig },
			{ env },
		)
		const { browser } = debuggable
		return {
			...debuggable,
			home,
			env,
			cli: createCli({ env, runtime }),
			context,
			page,
			watcher,
			close: async () => {
				await stopProcess(watcher.proc)
				await browser.close()
				await removeDir(home)
			},
		}
	} catch (error) {
		await debuggable?.browser.close()
		await removeDir(home)
		throw error
	}
}
