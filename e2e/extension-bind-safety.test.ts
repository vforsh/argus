/** CLI -> registry -> HTTP integration regressions for bind identity, retry, capabilities, and errors. */
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { delay, type RegistryV1, type WatcherRecord } from '@vforsh/argus-core'
import { runCommandWithExit } from './helpers/process.js'
import { startStubWatcher, type StubRoutes, type StubWatcher } from './helpers/stubWatcher.js'

const bin = path.resolve('packages/argus/dist/bin.js')
const stubs: StubWatcher[] = []
afterEach(async () => {
	await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

const stub = async (id: string): Promise<StubWatcher> => {
	const watcher = await startStubWatcher({}, id)
	stubs.push(watcher)
	return watcher
}

const extensionRecord = (watcher: StubWatcher, registry: RegistryV1, role: 'control' | 'tab'): WatcherRecord => ({
	...registry.watchers[watcher.watcherId],
	source: 'extension',
	extensionRole: role,
	ownerId: `${watcher.watcherId}-owner`,
})

const makeFixture = async (attached = true) => {
	const control = await stub('control')
	const target = await stub('bound')
	const registry = await control.readRegistry()
	const controlRecord = extensionRecord(control, registry, 'control')
	const targetRecord = extensionRecord(target, await target.readRegistry(), 'tab')
	registry.watchers = { control: controlRecord, bound: targetRecord }
	const writeRegistry = () => fs.writeFileSync(control.registryPath, JSON.stringify(registry))
	writeRegistry()
	const home = path.dirname(control.registryPath)
	const cli = async (...args: string[]) => {
		const result = await runCommandWithExit('node', [bin, ...args, '--json'], {
			env: { ...process.env, ARGUS_HOME: home, ARGUS_REGISTRY_PATH: control.registryPath },
		})
		return { code: result.code, json: JSON.parse(result.stdout) }
	}
	const tab = { tabId: 7, url: '', title: 'Ticket tab', attached, watcherId: attached ? targetRecord.id : undefined }
	const status = (record: WatcherRecord) => ({ ok: true, id: record.id, pid: record.pid, ownerId: record.ownerId })
	const targetStatus = () => ({ ...status(targetRecord), attached: true, targetReady: true, target: { url: tab.url, title: tab.title } })
	const controlRoutes: StubRoutes = {
		'GET /status': { payload: status(controlRecord) },
		'GET /bind': (call) => ({ text: `<html>${call.query.get('ticket')}</html>`, contentType: 'text/html' }),
		'GET /extension/diagnostics': () => ({
			payload: {
				ok: true,
				extension: { instanceId: 'browser-A' },
				control: { connected: true },
				tabWatchers: tab.attached
					? [
							{
								tabId: tab.tabId,
								connected: true,
								watcherId: targetRecord.id,
								watcherHost: targetRecord.host,
								watcherPort: targetRecord.port,
								pid: targetRecord.pid,
							},
						]
					: [],
			},
		}),
		'GET /tabs': () => ({ payload: { ok: true, tabs: [tab] } }),
		'POST /attach': () => {
			tab.attached = true
			tab.watcherId = targetRecord.id
			return { payload: { ok: true, tab, watcherId: targetRecord.id } }
		},
	}
	const targetRoutes: StubRoutes = {
		'GET /status': () => ({ payload: targetStatus() }),
		'POST /navigate': (call) => {
			tab.url = String(call.body.url)
			return { payload: { ok: true, url: tab.url } }
		},
		'GET /visibility': { payload: { ok: true, attached: true, state: 'default', policy: 'foreground' } },
		'POST /visibility': (call) => ({ payload: { ok: true, attached: true, state: 'shown', policy: call.body.policy } }),
	}
	control.setRoutes(controlRoutes)
	target.setRoutes(targetRoutes)
	const prepared = await cli('ext', 'bind', 'prepare', '--to', 'https://destination.test/')
	expect(prepared.code).toBe(0)
	const ticket = prepared.json.ticket as string
	tab.url = prepared.json.bindUrl
	const ticketsPath = path.join(home, 'bind-tickets.json')
	const readTickets = () => JSON.parse(fs.readFileSync(ticketsPath, 'utf8'))
	const updateTicket = (update: (entry: Record<string, unknown>) => void) => {
		const file = readTickets()
		update(file.tickets[ticket])
		fs.writeFileSync(ticketsPath, JSON.stringify(file))
	}
	const bind = (...args: string[]) => cli('ext', 'bind', ticket, ...args)
	return {
		control,
		target,
		controlRecord,
		targetRecord,
		controlRoutes,
		targetRoutes,
		registry,
		writeRegistry,
		cli,
		bind,
		ticket,
		tab,
		home,
		readTickets,
		updateTicket,
		targetStatus,
	}
}

test('refuses a control owner replacement after ticket discovery without attaching or navigating', async () => {
	const f = await makeFixture(false)
	f.control.setRoutes({
		...f.controlRoutes,
		'GET /tabs': () => {
			f.registry.watchers.control = { ...f.controlRecord, ownerId: 'browser-B-owner' }
			f.writeRegistry()
			return { payload: { ok: true, tabs: [f.tab] } }
		},
	})
	const result = await f.bind()
	expect(result.json).toMatchObject({ ok: false, error: { code: 'registration_conflict' } })
	expect(f.control.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
	expect(f.target.calls).toHaveLength(0)
})

test('refuses a tab watcher replacement even when its status and watcher name match the selected tab', async () => {
	const f = await makeFixture()
	const replacement = await stub('bound')
	const foreign = extensionRecord(replacement, await replacement.readRegistry(), 'tab')
	foreign.ownerId = 'foreign-tab-owner'
	replacement.setRoutes({
		'GET /status': { payload: { ...f.targetStatus(), ownerId: foreign.ownerId } },
		'POST /navigate': { payload: { ok: true, url: 'wrong' } },
	})
	f.registry.watchers.bound = foreign
	f.writeRegistry()
	const result = await f.bind()
	expect(result.json).toMatchObject({ ok: false, error: { code: 'registration_conflict' } })
	expect(replacement.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
	expect(f.target.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
})

test('a changed browser connection cannot attach the selected tab', async () => {
	const f = await makeFixture(false)
	let probes = 0
	const diagnostics = f.controlRoutes['GET /extension/diagnostics']
	f.control.setRoutes({
		...f.controlRoutes,
		'GET /extension/diagnostics': (call) => {
			probes += 1
			return probes === 1 && typeof diagnostics === 'function'
				? diagnostics(call)
				: { payload: { ok: true, extension: { instanceId: 'browser-B' }, control: { connected: true } } }
		},
	})
	expect((await f.bind()).json.error.code).toBe('registration_conflict')
	expect(f.control.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
})

test('an HTTP tab watcher with a missing/replaced owner token fails before navigation', async () => {
	const f = await makeFixture()
	f.target.setRoutes({ ...f.targetRoutes, 'GET /status': { payload: { ...f.targetStatus(), ownerId: undefined } } })
	expect((await f.bind()).json.error.code).toBe('registration_conflict')
	expect(f.target.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
})

test('a watcher replaced during navigation receives no visibility mutation and cannot resume the checkpoint', async () => {
	const f = await makeFixture()
	f.target.setRoutes({
		...f.targetRoutes,
		'POST /navigate': (call) => {
			f.tab.url = String(call.body.url)
			f.registry.watchers.bound = { ...f.targetRecord, ownerId: 'replacement-owner' }
			f.writeRegistry()
			return { payload: { ok: true, url: f.tab.url } }
		},
	})
	expect((await f.bind('--visibility', 'background')).json.error.code).toBe('registration_conflict')
	expect((await f.bind('--visibility', 'background')).json.error.code).toBe('registration_conflict')
	expect(f.target.calls.filter((call) => call.path === '/navigate')).toHaveLength(1)
	expect(f.target.calls.filter((call) => call.path === '/visibility')).toHaveLength(0)
})

test('resumes after the URL locator is gone without repeating completed navigation; spent and expired tickets stay closed', async () => {
	const f = await makeFixture()
	const labelsPath = path.join(f.home, 'browsers.json')
	fs.mkdirSync(labelsPath)
	const failed = await f.bind('--label', 'codex')
	expect(failed.json.error.message).toContain('EISDIR')
	expect(f.tab.url).toBe('https://destination.test/')
	expect(f.readTickets().tickets[f.ticket]).toMatchObject({ checkpoint: { navigatedUrl: f.tab.url } })
	expect(f.readTickets().tickets[f.ticket].claim).toBeUndefined()
	fs.rmdirSync(labelsPath)
	// A crashed CLI's claim is reclaimable, but only with the same checkpoint and before expiry.
	f.updateTicket((entry) => {
		entry.claim = { id: 'dead-attempt', pid: 2_147_483_647 }
	})
	const retried = await f.bind('--label', 'codex')
	expect(retried.code).toBe(0)
	expect(retried.json).toMatchObject({ watcherId: 'bound', tabId: 7, browser: { label: 'codex' } })
	expect(f.target.calls.filter((call) => call.path === '/navigate')).toHaveLength(1)
	expect((await f.bind()).json.error.code).toBe('bind_ticket_used')
})

test('an unfinished checkpoint expires and never follows a new control/browser owner', async () => {
	const f = await makeFixture()
	f.target.setRoutes({
		...f.targetRoutes,
		'POST /navigate': () => {
			f.tab.url = 'https://destination.test/'
			return { status: 500, payload: { ok: false, error: { code: 'navigation_failed', message: 'Lost navigation result' } } }
		},
	})
	expect((await f.bind()).json.error.code).toBe('navigation_failed')
	expect(f.readTickets().tickets[f.ticket].checkpoint.navigatedUrl).toBeUndefined()
	f.registry.watchers.control = { ...f.controlRecord, ownerId: 'new-control-owner' }
	f.writeRegistry()
	expect((await f.bind()).json.error.code).toBe('registration_conflict')
	expect(f.target.calls.filter((call) => call.path === '/navigate')).toHaveLength(1)
	f.updateTicket((entry) => {
		entry.expiresAt = Date.now() - 1
	})
	expect((await f.bind()).json.error.code).toBe('bind_ticket_expired')
})

test('a lost navigation result resumes the same pinned watcher and rejects concurrent bind attempts', async () => {
	const f = await makeFixture()
	f.target.setRoutes({
		...f.targetRoutes,
		'POST /navigate': (call) => {
			f.tab.url = String(call.body.url)
			return { status: 500, payload: { ok: false, error: { code: 'navigation_timeout', message: 'Result lost' } } }
		},
	})
	expect((await f.bind()).json.error.code).toBe('navigation_timeout')
	f.target.setRoutes({
		...f.targetRoutes,
		'POST /navigate': (call) => {
			f.tab.url = String(call.body.url)
			return { delayMs: 500, payload: { ok: true, url: f.tab.url } }
		},
	})
	const resumed = f.bind()
	const deadline = Date.now() + 2_000
	while (f.target.calls.filter((call) => call.path === '/navigate').length < 2 && Date.now() < deadline) await delay(10)
	expect(f.target.calls.filter((call) => call.path === '/navigate')).toHaveLength(2)
	expect((await f.bind()).json.error.code).toBe('bind_ticket_used')
	expect((await resumed).code).toBe(0)
	expect(f.target.calls.filter((call) => call.path === '/navigate')).toHaveLength(2)
})

for (const legacy of [
	{ status: 404, payload: { ok: false, error: { code: 'not_found', message: 'Old route' } } },
	{ payload: { ok: true, attached: true, state: 'shown' } },
]) {
	test(`bind background shares canonical visibility compatibility checks (${legacy.status ?? 'malformed'})`, async () => {
		const f = await makeFixture()
		f.target.setRoutes({ ...f.targetRoutes, 'GET /visibility': legacy })
		for (const run of [() => f.cli('page', 'show', 'bound', '--policy', 'background'), () => f.bind('--visibility', 'background')]) {
			expect((await run()).json).toMatchObject({ ok: false, error: { code: 'not_available' } })
		}
		expect(f.target.calls.filter((call) => call.method === 'POST' && call.path === '/visibility')).toHaveLength(0)
		f.target.setRoutes(f.targetRoutes)
		expect((await f.bind('--visibility', 'background')).json).toMatchObject({ ok: true, visibility: 'background' })
	})
}

test('prepare probes the real bind endpoint and selects a capable control among legacy owners', async () => {
	const f = await makeFixture()
	const { 'GET /bind': _bindPage, ...oldRoutes } = f.controlRoutes
	f.control.setRoutes(oldRoutes)
	expect((await f.cli('ext', 'bind', 'prepare', '--to', 'https://destination.test/')).json.error.code).toBe('not_available')
	const capable = await stub('capable')
	const record = extensionRecord(capable, await capable.readRegistry(), 'control')
	delete record.ownerId // Endpoint support is independent of ownership metadata in either direction.
	f.registry.watchers.capable = record
	f.writeRegistry()
	capable.setRoutes({
		'GET /status': { payload: { ok: true, id: record.id, pid: record.pid } },
		'GET /bind': f.controlRoutes['GET /bind'],
	})
	const prepared = await f.cli('ext', 'bind', 'prepare', '--to', 'https://destination.test/')
	expect(prepared.code).toBe(0)
	expect(new URL(prepared.json.bindUrl).port).toBe(String(record.port))
	expect(f.control.calls.some((call) => call.path === '/bind')).toBe(true)
	expect(capable.calls.some((call) => call.path === '/bind')).toBe(true)
})

for (const code of ['watcher_id_taken', 'tab_owned_by_other_debugger']) {
	test(`all shared attach flows preserve ${code}`, async () => {
		const f = await makeFixture(false)
		f.control.setRoutes({
			...f.controlRoutes,
			'POST /attach': { status: 409, payload: { ok: false, error: { code, message: 'Attach refused' } } },
		})
		for (const command of [
			['ext', 'use'],
			['ext', 'show'],
			['ext', 'attach', '--show'],
			['ext', 'attach'],
		]) {
			const result = await f.cli(...command, '--id', 'control', '--tab', '7', '--as', 'bound')
			expect(result.json).toEqual({ ok: false, error: { code, message: 'Attach refused' } })
		}
		expect((await f.bind('--as', 'bound')).json).toEqual({ ok: false, error: { code, message: 'Attach refused' } })
		expect(f.target.calls).toHaveLength(0)
	})
}
