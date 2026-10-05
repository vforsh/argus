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

test('doctor flags a host running another watcher build and names the next action', async () => {
	const stub = await startExtensionStub()
	try {
		stub.setRoutes({ 'GET /status': { payload: { ok: true, id: 'extension-control', attached: false, watcherVersion: '0.0.1' } } })
		const result = await stub.cli('ext', 'doctor', '--id', 'extension-control', '--json')
		const report = JSON.parse(result.stdout) as { versionSkew: Array<{ watcherId: string; hostVersion: string }>; issues: string[] }
		expect(report.versionSkew.map((skew) => [skew.watcherId, skew.hostVersion])).toEqual([
			['extension-control', '0.0.1'],
			['test-tab', '0.0.1'],
		])
		expect(report.issues.some((issue) => issue.includes('runs watcher 0.0.1') && issue.includes('chrome://extensions'))).toBe(true)
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

test('CLI mutes by watcher id and unmutes by tab selector', async () => {
	const stub = await startExtensionStub()
	try {
		const tab = { tabId: 42, url: 'https://host.test', title: 'Host', attached: true, watcherId: 'test-tab' }
		stub.setRoutes({
			'GET /status': { payload: { ok: true, attached: false } },
			'GET /tabs': { payload: { ok: true, tabs: [tab] } },
			'POST /tabs/mute': { payload: { ok: true, tab, muted: true } },
		})

		const mute = await stub.cli('ext', 'mute', 'test-tab', '--json')
		expect(mute.code).toBe(0)
		expect(JSON.parse(mute.stdout)).toMatchObject({ ok: true, muted: true, tab: { tabId: 42 } })
		expect(stub.calls.find((call) => call.path === '/tabs/mute')?.body).toEqual({ tabId: 42, muted: true })

		stub.setRoutes({
			'GET /status': { payload: { ok: true, attached: false } },
			'GET /tabs': { payload: { ok: true, tabs: [tab] } },
			'POST /tabs/mute': { payload: { ok: true, tab, muted: false } },
		})
		const unmute = await stub.cli('ext', 'unmute', '--url', 'host.test', '--json')
		expect(unmute.code).toBe(0)
		expect(JSON.parse(unmute.stdout)).toMatchObject({ ok: true, muted: false, tab: { tabId: 42 } })
		expect(stub.calls.filter((call) => call.path === '/tabs/mute').at(-1)?.body).toEqual({ tabId: 42, muted: false })
	} finally {
		await stub.close()
	}
})

async function startExtensionStub() {
	const stub = await startStubWatcher({}, 'extension-control')
	const registry = await stub.readRegistry()
	// Both records point at the one stub server, so the role must come from the record (as current hosts write it).
	registry.watchers['extension-control'] = {
		...registry.watchers['extension-control'],
		source: 'extension',
		extensionRole: 'control',
		ownerId: 'stub-control',
	}
	registry.watchers['test-tab'] = { ...registry.watchers['extension-control'], id: 'test-tab', extensionRole: 'tab', ownerId: 'stub-tab' }
	await fs.writeFile(stub.registryPath, JSON.stringify(registry))
	const dir = path.dirname(stub.registryPath)
	return {
		...stub,
		setRoutes: (routes: StubRoutes) =>
			stub.setRoutes({
				'GET /extension/diagnostics': {
					payload: { ok: true, extension: { id: null, version: null }, control: { connected: true }, tabWatchers: [], recentEvents: [] },
				},
				...routes,
			}),
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
