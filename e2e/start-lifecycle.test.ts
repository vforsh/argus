import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import type { StartResult } from '../packages/argus/src/commands/start.js'
import { runCommand, runCommandWithExit, spawnAndWait, stopProcess } from './helpers/process.js'
import { waitForWatcherAttached } from './helpers/watcher.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')
const BUNDLE_PATH = path.resolve('packages/argus/dist/argus.js')

describe('combined Chrome + watcher lifecycle', () => {
	let tempDir: string
	let env: Record<string, string | undefined>
	let origin: string
	let site: http.Server
	const sessions: StartResult[] = []
	const processes: ChildProcess[] = []

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-start-e2e-'))
		env = { ...process.env, ARGUS_HOME: tempDir, ARGUS_CHROME_BIN: chromium.executablePath() }
		site = http.createServer((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/html' })
			response.end(`<!doctype html><title>headless lifecycle</title><canvas id="game" tabindex="0"></canvas>
				<script>window.canvasKeys = []; document.querySelector('canvas').addEventListener('keydown', e => canvasKeys.push(e.code));</script>`)
		})
		await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
	})

	afterAll(async () => {
		for (const session of sessions) {
			await runCommandWithExit('bun', [BIN_PATH, 'watcher', 'stop', session.id, '--json'], { env })
		}
		await Promise.all(processes.map((proc) => stopProcess(proc, { timeoutMs: 10_000 })))
		for (const session of sessions) await waitForSessionClosed(session)
		await new Promise<void>((resolve) => site?.close(() => resolve()))
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const start = async (id: string, runtime: 'bun' | 'node', command: 'start' | 'up', flags: string[] = []): Promise<StartResult> => {
		const { stdout } = await runCommand(
			runtime,
			[
				runtime === 'bun' ? BUNDLE_PATH : BIN_PATH,
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
			],
			{ env },
		)
		const session = JSON.parse(stdout) as StartResult
		sessions.push(session)
		expect(session.id).toBe(id)
		expect(session.chromePid).toBeGreaterThan(0)
		expect(session.watcherPid).toBeGreaterThan(0)
		expect(session.launcherLog).toBeTruthy()
		return session
	}

	const evaluate = async (id: string, expression: string): Promise<unknown> => {
		const { stdout } = await runCommand('bun', [BIN_PATH, 'eval', id, expression, '--json'], { env })
		return (JSON.parse(stdout) as { result: unknown }).result
	}

	test('Bun up and Node start detach return ready sessions; stopping one closes only its own Chrome and profile', async () => {
		const [first, second] = await Promise.all([
			start('detached-bun', 'bun', 'up'),
			start('detached-node', 'node', 'start', ['--width', '900', '--height', '1250', '--dpr', '2']),
		])
		expect(first.cdpPort).not.toBe(second.cdpPort)
		expect(await evaluate(first.id, '[innerWidth, innerHeight, devicePixelRatio]')).toEqual([1280, 900, 1])
		expect(await evaluate(second.id, '[innerWidth, innerHeight, devicePixelRatio]')).toEqual([900, 1250, 2])

		const { stdout: screenshotOut } = await runCommand('bun', [BIN_PATH, 'screenshot', second.id, '--json'], { env })
		const screenshot = await fs.readFile((JSON.parse(screenshotOut) as { outFile: string }).outFile)
		expect([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)]).toEqual([1800, 2500])

		const { stdout } = await runCommand('bun', [BIN_PATH, 'watcher', 'stop', first.id, '--json'], { env })
		expect(JSON.parse(stdout)).toEqual({ ok: true, id: first.id, stopped: true })
		await waitForSessionClosed(first)
		expect(await evaluate(second.id, 'document.title')).toBe('headless lifecycle')
	}, 30_000)

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
	}, 20_000)

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
		const stopped = await runCommand('bun', [BIN_PATH, 'watcher', 'stop', '--port', String(watcher.port), '--json'], { env })
		expect(JSON.parse(stopped.stdout).id).toBe('standalone')
		expect(await evaluate(owner.id, 'document.title')).toBe('headless lifecycle')
	}, 20_000)

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
			const { stdout } = await runCommand('bun', [BIN_PATH, 'eval', id, '--file', file, '--body', '--arg', 'input=ok'], { env })
			expect(JSON.parse(stdout)).toEqual({ ...nested, input: 'ok' })
		}
		const { stdout: stdinOut } = await runCommand('bun', [BIN_PATH, 'eval', id, '--stdin', '--body', '--json'], {
			env,
			input: 'return await Promise.resolve(99);',
		})
		expect(JSON.parse(stdinOut).result).toBe(99)
		await runCommand('bun', [BIN_PATH, 'keydown', id, '--code', 'KeyG', '--selector', 'canvas', '--json'], { env })
		expect(await evaluate(id, 'canvasKeys')).toEqual(['KeyG'])
	}, 20_000)

	test('duplicate ids and invalid metrics fail without replacing the live session', async () => {
		const duplicate = await runCommandWithExit(
			'bun',
			[BUNDLE_PATH, 'start', '--id', 'detached-node', '--url', origin, '--headless', '--profile', 'temp', '--detach', '--json'],
			{ env },
		)
		expect(duplicate.code).toBe(1)
		expect(duplicate.stdout).toBe('')
		expect(duplicate.stderr).toContain('already in use')
		const invalid = await runCommandWithExit(
			'bun',
			[BIN_PATH, 'start', '--id', 'invalid', '--type', 'page', '--headless', '--profile', 'temp', '--detach', '--width', '0', '--json'],
			{ env },
		)
		expect(invalid.code).toBe(2)
		expect(invalid.stderr).toContain('--width must be a positive integer')
		expect(await evaluate('detached-node', 'document.title')).toBe('headless lifecycle')
	}, 20_000)

	test('chrome stop accepts a scoped local CDP port and closes the owning watcher', async () => {
		const owner = sessions.find((session) => session.id === 'detached-node')!
		const { stdout } = await runCommand('bun', [BIN_PATH, 'chrome', 'stop', '--port', String(owner.cdpPort), '--json'], { env })
		expect(JSON.parse(stdout).closed).toBe(true)
		await waitForSessionClosed(owner)
	}, 20_000)

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
	}, 25_000)
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
