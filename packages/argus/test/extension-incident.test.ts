import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectExtensionDoctor } from '../src/commands/extension/doctor.js'
import { collectIncident } from '../src/commands/extension/diagnose.js'
import { installNativeHostsTo } from '../src/commands/extension/nativeHost.js'
import { ARGUS_EXTENSION_ID } from '../src/commands/extension/extensionId.js'

const originalHome = process.env.ARGUS_HOME
const originalRegistry = process.env.ARGUS_REGISTRY_PATH
let temp: string | undefined
let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
	server?.stop(true)
	server = undefined
	if (temp) fs.rmSync(temp, { recursive: true, force: true })
	if (originalHome === undefined) delete process.env.ARGUS_HOME
	else process.env.ARGUS_HOME = originalHome
	if (originalRegistry === undefined) delete process.env.ARGUS_REGISTRY_PATH
	else process.env.ARGUS_REGISTRY_PATH = originalRegistry
})

function isolate() {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-incident-'))
	process.env.ARGUS_HOME = temp
	process.env.ARGUS_REGISTRY_PATH = path.join(temp, 'registry.json')
	return temp
}

function writeRegistry(watchers: Record<string, unknown>) {
	const content = JSON.stringify({ version: 1, updatedAt: Date.now(), watchers })
	fs.writeFileSync(process.env.ARGUS_REGISTRY_PATH!, content)
	return content
}

test('absent worker still produces a private bundle and preserves stale registry evidence', async () => {
	const root = isolate()
	const original = writeRegistry({
		stale: {
			id: 'stale',
			pid: 2147483647,
			host: '127.0.0.1',
			port: 1,
			source: 'extension',
			startedAt: 1,
			updatedAt: 1,
			match: { url: 'https://user:SECRET@example.test/?token=SECRET#SECRET', title: 'SECRET' },
		},
	})
	const bundle = await collectIncident({ out: path.join(root, 'bundle') })
	expect(bundle.doctor.diagnostics).toBeNull()
	expect(bundle.doctor.layers[0]?.staleRegistry).toBe(true)
	expect(fs.readFileSync(process.env.ARGUS_REGISTRY_PATH!, 'utf8')).toBe(original)
	const text = fs.readFileSync(path.join(bundle.directory, 'incident.json'), 'utf8')
	expect(text).not.toContain('SECRET')
	expect(text).toContain('receipt unconfirmed')
	if (process.platform !== 'win32') expect(fs.statSync(path.join(bundle.directory, 'incident.json')).mode & 0o777).toBe(0o600)
	await expect(collectIncident({ out: bundle.directory })).rejects.toThrow()
})

test('simulated live host/unresponsive worker returns status and request phase after a bounded deadline', async () => {
	isolate()
	server = Bun.serve({
		port: 0,
		fetch: (request) => {
			if (new URL(request.url).pathname === '/extension/diagnostics') return new Promise<Response>(() => {})
			if (new URL(request.url).pathname === '/targets') return Response.json({ ok: false, error: { message: 'targets unavailable' } })
			return Response.json({ ok: true, id: 'extension-control', pid: process.pid, attached: false, targetReady: null })
		},
	})
	writeRegistry({
		'extension-control': {
			id: 'extension-control',
			pid: process.pid,
			host: '127.0.0.1',
			port: server.port,
			source: 'extension',
			startedAt: Date.now(),
			updatedAt: Date.now(),
		},
	})
	const result = await collectExtensionDoctor({ watcher: 'extension-control' })
	expect(result.layers[0]?.transport).toBe('responded')
	expect(result.diagnostics).toBeNull()
	expect(result.controlRequest?.outcome).toBe('error')
	expect(result.controlRequest?.elapsedMs).toBeGreaterThanOrEqual(5900)
	expect(result.controlRequest?.lastConfirmedPhase).toContain('receipt unconfirmed')
	expect(result.watcherDiagnostics?.status?.ok).toBe(true)
	expect(result.issues.some((issue) => issue.includes('targets unavailable'))).toBe(true)
}, 10000)

test('shell wrapper records startup/stderr when the runtime cannot start, without writing stdout', async () => {
	const root = isolate()
	const manifestDir = path.join(root, 'manifests')
	const installed = installNativeHostsTo(manifestDir, ARGUS_EXTENSION_ID, '/not-installed/SECRET-cli', {
		env: { ARGUS_HOME: root },
		nodePath: '/not-installed/SECRET-runtime',
	})
	let stdout = ''
	try {
		execFileSync(installed[0]!.wrapperPath, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' })
	} catch (error) {
		stdout = String((error as { stdout: unknown }).stdout)
	}
	expect(stdout).toBe('')
	const log = path.join(root, 'incidents', 'startup-tab.jsonl')
	let journal = fs.readFileSync(log, 'utf8')
	for (let i = 0; i < 20 && !journal.includes('stderr.observed'); i++) {
		await new Promise((resolve) => setTimeout(resolve, 100))
		journal = fs.readFileSync(log, 'utf8')
	}
	expect(journal).toContain('wrapper.start')
	expect(journal).toContain('stderr.observed')
	expect(journal).not.toContain('SECRET')
})

test('simulated PID/port reuse is marked stale even though the responding process is alive', async () => {
	isolate()
	server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, id: 'different-watcher', pid: process.pid, attached: true }) })
	writeRegistry({ stale: { id: 'stale', pid: process.pid, host: '127.0.0.1', port: server.port, source: 'extension', startedAt: 1, updatedAt: 1 } })
	const result = await collectExtensionDoctor()
	expect(result.layers[0]).toMatchObject({ processExists: true, transport: 'responded', registryIdentityMatches: false, staleRegistry: true })
	expect(result.issues.some((issue) => issue.includes('different responding watcher'))).toBe(true)
})
