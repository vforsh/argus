import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import type { StartResult } from '../../packages/argus/src/commands/start.js'
import { argusEnv, createCli, type Cli } from '../helpers/cli.js'
import { BIN_PATH, BUNDLE_PATH } from '../helpers/paths.js'
import { spawnAndWait, stopProcess } from '../helpers/process.js'
import { startSite, type Site } from '../helpers/site.js'
import { makeTempDir, removeDir } from '../helpers/tempDir.js'
import { TIMEOUTS } from '../helpers/timeouts.js'
import { waitForWatcherAttached } from '../helpers/watcher.js'

setDefaultTimeout(TIMEOUTS.browser)

describe('combined Chrome + watcher lifecycle', () => {
	let tempDir: string
	let env: NodeJS.ProcessEnv
	let site: Site | undefined
	let origin: string
	let cli: Cli
	let nodeCli: Cli
	let bundleCli: Cli
	const sessions: StartResult[] = []
	const processes: ChildProcess[] = []

	beforeAll(async () => {
		tempDir = await makeTempDir('argus-start-e2e')
		env = argusEnv(tempDir, { ARGUS_CHROME_BIN: chromium.executablePath() })
		cli = createCli({ env })
		nodeCli = createCli({ env, runtime: 'node' })
		bundleCli = createCli({ env, bin: BUNDLE_PATH })
		site = await startSite((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/html' })
			response.end(`<!doctype html><title>headless lifecycle</title><canvas id="game" tabindex="0"></canvas>
				<script>window.canvasKeys = []; document.querySelector('canvas').addEventListener('keydown', e => canvasKeys.push(e.code));</script>`)
		})
		origin = site.origin
	})

	afterAll(async () => {
		for (const session of sessions) {
			await cli.exec(['watcher', 'stop', session.id, '--json'])
		}
		await Promise.all(processes.map((proc) => stopProcess(proc, { timeoutMs: 10_000 })))
		for (const session of sessions) await waitForSessionClosed(session)
		await site?.close()
		await removeDir(tempDir)
	})

	const start = async (id: string, runtime: 'bun' | 'node', command: 'start' | 'up', flags: string[] = []): Promise<StartResult> => {
		const session = await (runtime === 'bun' ? bundleCli : nodeCli).json<StartResult>([
			command,
			'--id',
			id,
			'--url',
			origin,
			'--headless',
			'--profile',
			'temp',
			'--detach',
			'--json',
			...flags,
		])
		sessions.push(session)
		expect(session.id).toBe(id)
		expect(session.chromePid).toBeGreaterThan(0)
		expect(session.watcherPid).toBeGreaterThan(0)
		expect(session.launcherLog).toBeTruthy()
		return session
	}

	const evaluate = async (id: string, expression: string): Promise<unknown> =>
		(await cli.json<{ result: unknown }>(['eval', id, expression, '--json'])).result

	test('Bun up and Node start detach return ready sessions; stopping one closes only its own Chrome and profile', async () => {
		const [first, second] = await Promise.all([
			start('detached-bun', 'bun', 'up'),
			start('detached-node', 'node', 'start', ['--width', '900', '--height', '1250', '--dpr', '2']),
		])
		expect(first.cdpPort).not.toBe(second.cdpPort)
		expect(await evaluate(first.id, '[innerWidth, innerHeight, devicePixelRatio]')).toEqual([1280, 900, 1])
		expect(await evaluate(second.id, '[innerWidth, innerHeight, devicePixelRatio]')).toEqual([900, 1250, 2])

		const { outFile } = await cli.json<{ outFile: string }>(['screenshot', second.id, '--json'])
		const screenshot = await fs.readFile(outFile)
		expect([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)]).toEqual([1800, 2500])

		expect(await cli.json<Record<string, unknown>>(['watcher', 'stop', first.id, '--json'])).toEqual({ ok: true, id: first.id, stopped: true })
		await waitForSessionClosed(first)
		expect(await evaluate(second.id, 'document.title')).toBe('headless lifecycle')
	})

	test('foreground up waits for attachment and POST /shutdown closes the entire session', async () => {
		const id = 'foreground-owner'
		const { proc, stdout } = await spawnAndWait(
			'node',
			[BIN_PATH, 'up', '--id', id, '--url', origin, '--headless', '--profile', 'temp', '--json'],
			{ env },
			/\{"id":"foreground-owner"/,
		)
		processes.push(proc)
		const session = JSON.parse(stdout.trim()) as StartResult
		sessions.push(session)
		expect(await evaluate(id, 'document.title')).toBe('headless lifecycle')
		const response = await fetch(`http://${session.watcherHost}:${session.watcherPort}/shutdown`, { method: 'POST' })
		expect(await response.json()).toEqual({ ok: true })
		await waitForSessionClosed(session)
		expect(proc.exitCode).toBe(0)
		expect(await evaluate('detached-node', 'document.title')).toBe('headless lifecycle')
	})

	test('stopping a standalone watcher by HTTP port preserves the Chrome it attached to', async () => {
		const owner = sessions.find((session) => session.id === 'detached-node')!
		const { proc, stdout } = await spawnAndWait(
			'bun',
			[BIN_PATH, 'watcher', 'start', '--id', 'standalone', '--url', origin, '--chrome-port', String(owner.cdpPort), '--json'],
			{ env },
			/\{"id":"standalone"/,
		)
		processes.push(proc)
		await waitForWatcherAttached(BIN_PATH, 'standalone', { env })
		const watcher = JSON.parse(stdout.trim()) as { port: number }
		const stopped = await cli.json<{ id: string }>(['watcher', 'stop', '--port', String(watcher.port), '--json'])
		expect(stopped.id).toBe('standalone')
		expect(await evaluate(owner.id, 'document.title')).toBe('headless lifecycle')
	})

	test('repeated declarations, async script bodies, complete output, and explicit canvas input work', async () => {
		const id = 'detached-node'
		for (let i = 0; i < 2; i++) {
			expect(await evaluate(id, 'const repeatable = 42; repeatable')).toBe(42)
			expect(await evaluate(id, 'let repeatableLet = await Promise.resolve(43); repeatableLet')).toBe(43)
		}
		const nested = { a: { b: { c: { d: [1, 2, 3] } } } }
		const file = path.join(tempDir, 'body.js')
		await fs.writeFile(file, `const value = await Promise.resolve(${JSON.stringify(nested)}); return { ...value, input: args.input };`)
		for (let i = 0; i < 2; i++) {
			expect(await cli.json<Record<string, unknown>>(['eval', id, '--file', file, '--body', '--arg', 'input=ok'])).toEqual({ ...nested, input: 'ok' })
		}
		const stdinResult = await cli.json<{ result: unknown }>(['eval', id, '--stdin', '--body', '--json'], {
			input: 'return await Promise.resolve(99);',
		})
		expect(stdinResult.result).toBe(99)
		await cli.run(['keydown', id, '--code', 'KeyG', '--selector', 'canvas', '--json'])
		expect(await evaluate(id, 'canvasKeys')).toEqual(['KeyG'])
	})

	test('duplicate ids and invalid metrics fail without replacing the live session', async () => {
		const duplicate = await bundleCli.exec([
			'start',
			'--id',
			'detached-node',
			'--url',
			origin,
			'--headless',
			'--profile',
			'temp',
			'--detach',
			'--json',
		])
		expect(duplicate.code).toBe(1)
		expect(duplicate.stdout).toBe('')
		expect(duplicate.stderr).toContain('already in use')
		const invalid = await cli.exec([
			'start',
			'--id',
			'invalid',
			'--type',
			'page',
			'--headless',
			'--profile',
			'temp',
			'--detach',
			'--width',
			'0',
			'--json',
		])
		expect(invalid.code).toBe(2)
		expect(invalid.stderr).toContain('--width must be a positive integer')
		expect(await evaluate('detached-node', 'document.title')).toBe('headless lifecycle')
	})

	test('chrome stop accepts a scoped local CDP port and closes the owning watcher', async () => {
		const owner = sessions.find((session) => session.id === 'detached-node')!
		const stopped = await cli.json<{ closed: boolean }>(['chrome', 'stop', '--port', String(owner.cdpPort), '--json'])
		expect(stopped.closed).toBe(true)
		await waitForSessionClosed(owner)
	})

	test('a target that never attaches fails startup and removes the launched browser', async () => {
		const { proc, stdout } = await spawnAndWait(
			'node',
			[BIN_PATH, 'start', '--id', 'missing-target', '--target', 'argus-target-that-does-not-exist', '--headless', '--profile', 'temp'],
			{ env },
			/Chrome started \(pid=\d+/,
		)
		processes.push(proc)
		const chromePid = Number(stdout.match(/Chrome started \(pid=(\d+)/)![1])
		let stderr = ''
		proc.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		const code = await new Promise<number | null>((resolve) => proc.once('close', resolve))
		expect(code).toBe(1)
		expect(stderr).toContain('did not attach to a matching CDP target')
		expect(isAlive(chromePid)).toBe(false)
		const registry = JSON.parse(await fs.readFile(path.join(tempDir, 'registry.json'), 'utf8')) as { watchers: Record<string, unknown> }
		expect(registry.watchers['missing-target']).toBeUndefined()
	})
})

const waitForSessionClosed = async (session: StartResult): Promise<void> => {
	const deadline = Date.now() + 12_000
	while (Date.now() < deadline) {
		if (!isAlive(session.chromePid) && !isAlive(session.watcherPid)) {
			if (session.userDataDir) expect(await fs.exists(session.userDataDir)).toBe(false)
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Session ${session.id} still running (Chrome ${session.chromePid}, watcher ${session.watcherPid})`)
}

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
		throw error
	}
}

const LITERAL_USER_AGENT = 'Argus Literal Browser/14.0 exact'

describe('Chrome startup user agent e2e', () => {
	let tempDir: string
	let env: NodeJS.ProcessEnv
	let origin: string
	let site: Site | undefined
	let cli: Cli
	const requestUserAgents = new Map<string, string>()
	const processes: ChildProcess[] = []

	beforeAll(async () => {
		tempDir = await makeTempDir('argus-ua-e2e')
		env = argusEnv(tempDir)
		cli = createCli({ env, runtime: 'node' })
		site = await startSite((request, response) => {
			const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
			if (!requestUserAgents.has(pathname)) {
				requestUserAgents.set(pathname, request.headers['user-agent'] ?? '')
			}
			response.writeHead(200, { 'Content-Type': 'text/html' })
			response.end(`<!doctype html><title>${pathname}</title>`)
		})
		origin = site.origin
	})

	afterAll(async () => {
		await Promise.all(processes.map((process) => stopProcess(process)))
		await site?.close()
		await removeDir(tempDir)
	})

	test('chrome start sends an exact literal UA on the first request', async () => {
		const url = `${origin}/literal`
		const watcherId = `ua-literal-e2e-${Date.now()}`
		const { proc, stdout } = await spawnAndWait(
			'node',
			[BIN_PATH, 'chrome', 'start', '--url', url, '--headless', '--profile', 'temp', '--user-agent', LITERAL_USER_AGENT, '--json'],
			{ env },
			/\{"chromePid":/,
		)
		processes.push(proc)
		const info = JSON.parse(stdout.trim()) as { cdpHost: string; cdpPort: number; userAgentOverride: boolean }
		const { proc: watcherProc } = await spawnAndWait(
			'node',
			[BIN_PATH, 'watcher', 'start', '--id', watcherId, '--url', url, '--chrome-host', info.cdpHost, '--chrome-port', String(info.cdpPort), '--json'],
			{ env },
			new RegExp(`\\{"id":"${watcherId}"`),
		)
		processes.push(watcherProc)
		await waitForWatcherAttached(BIN_PATH, watcherId, { env })
		const { result } = await cli.json<{ result: string }>(['eval', watcherId, 'navigator.userAgent', '--json'])

		expect(result).toBe(LITERAL_USER_AGENT)
		expect(requestUserAgents.get('/literal')).toBe(LITERAL_USER_AGENT)
		expect(info.userAgentOverride).toBe(true)
	})

	test('combined start uses regular Chrome UA for the first request and page runtime', async () => {
		const url = `${origin}/regular`
		const watcherId = `ua-e2e-${Date.now()}`
		const { proc, stdout } = await spawnAndWait(
			'node',
			[BIN_PATH, 'start', '--id', watcherId, '--url', url, '--headless', '--profile', 'temp', '--user-agent', 'regular-chrome', '--json'],
			{ env },
			new RegExp(`\\{"id":"${watcherId}"`),
		)
		processes.push(proc)
		await waitForWatcherAttached(BIN_PATH, watcherId, { env })
		const info = JSON.parse(stdout.trim()) as { userAgentOverride: boolean }
		const { result: runtimeUserAgent } = await cli.json<{ result: string }>(['eval', watcherId, 'navigator.userAgent', '--json'])

		expect(runtimeUserAgent).toContain('Chrome/')
		expect(runtimeUserAgent).not.toContain('HeadlessChrome/')
		expect(requestUserAgents.get('/regular')).toBe(runtimeUserAgent)
		expect(info.userAgentOverride).toBe(true)
	})
})
