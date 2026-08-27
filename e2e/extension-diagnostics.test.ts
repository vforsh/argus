import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startStubWatcher, type StubRoutes } from './helpers/stubWatcher.js'
import { runCommandWithExit } from './helpers/process.js'

const BIN_PATH = path.resolve('packages/argus/dist/bin.js')

test('watcher doctor distinguishes bridge connectivity from attachment and target readiness', async () => {
	const stub = await startExtensionStub()
	try {
		for (const state of [
			{ attached: false, ready: null, connected: true, issue: 'no debugger-attached target' },
			{ attached: true, ready: false, connected: true, issue: 'selected target is not ready' },
			{ attached: true, ready: true, connected: false, issue: 'native bridge is disconnected' },
			{ attached: true, ready: true, connected: true, issue: null },
		]) {
			stub.setRoutes(diagnosticRoutes(state))
			const result = await stub.cli('ext', 'doctor', '--watcher', 'test-tab', '--json')
			const report = JSON.parse(result.stdout)
			expect(report.watcherDiagnostics.status.attached).toBe(state.attached)
			expect(report.watcherDiagnostics.bridge.connected).toBe(state.connected)
			const watcherIssues = report.issues.filter((issue: string) => issue.startsWith('Watcher test-tab'))
			if (state.issue) {
				expect(result.code).toBe(1)
				expect(report.ok).toBe(false)
				expect(watcherIssues).toHaveLength(1)
				expect(watcherIssues[0]).toContain(state.issue)
			} else {
				// Native host installation is machine-specific; the healthy target adds no issues.
				expect(watcherIssues).toEqual([])
			}
		}
	} finally {
		await stub.close()
	}
})

test('CLI attach returns the original Chrome error without waiting for a nonexistent tab watcher', async () => {
	const stub = await startExtensionStub()
	try {
		const error = 'Another debugger is already attached to the tab with id: 42.'
		stub.setRoutes({
			'GET /status': { payload: { ok: true, attached: false } },
			'GET /tabs': { payload: { ok: true, tabs: [{ tabId: 42, url: 'https://host.test', title: 'Host', attached: false }] } },
			'POST /attach': { status: 400, payload: { ok: false, error: { message: error } } },
		})
		const result = await stub.cli('ext', 'attach', '--tab', '42', '--as', 'requested', '--json')
		expect(result.code).toBe(1)
		expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: { message: error } })
		expect(stub.calls.filter((call) => call.path === '/tabs')).toHaveLength(1)
		expect(stub.calls.find((call) => call.path === '/attach')?.body).toEqual({ tabId: 42, watcherId: 'requested' })
	} finally {
		await stub.close()
	}
})

async function startExtensionStub() {
	const stub = await startStubWatcher({}, 'extension-control')
	const registry = await stub.readRegistry()
	registry.watchers['extension-control'].source = 'extension'
	registry.watchers['test-tab'] = { ...registry.watchers['extension-control'], id: 'test-tab' }
	await fs.writeFile(stub.registryPath, JSON.stringify(registry))
	const dir = path.dirname(stub.registryPath)
	return {
		...stub,
		cli: (...args: string[]) => runCommandWithExit('bun', [BIN_PATH, ...args], { cwd: dir, env: { ...process.env, ARGUS_HOME: dir } }),
	}
}

function diagnosticRoutes(state: { attached: boolean; ready: boolean | null; connected: boolean }): StubRoutes {
	const target = { id: 'tab:42', title: 'Host', url: 'https://host.test', type: 'page', attached: true }
	return {
		'GET /status': { payload: { ok: true, attached: state.attached, targetReady: state.ready, target: state.attached ? target : null } },
		'GET /targets': { payload: { ok: true, targets: state.attached ? [target] : [] } },
		'GET /extension/diagnostics': {
			payload: {
				ok: true,
				extension: { id: null, version: null },
				control: { connected: true },
				tabWatchers: [{ tabId: 42, watcherId: 'test-tab', connected: state.connected, targetReady: state.ready }],
				recentEvents: [],
			},
		},
	}
}
