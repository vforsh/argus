import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { delay, type RegistryV1, type StatusResponse, type WatcherRecord } from '@vforsh/argus-core'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'

const liveTest = resolveTestChromeBin() ? test : test.skip
if (!resolveTestChromeBin()) console.warn('[extension-multi-instance] No Chromium binary; skipping real-browser check.')

const readRegistryFile = async (registryPath: string): Promise<RegistryV1> => JSON.parse(await readFile(registryPath, 'utf8')) as RegistryV1

/** Registration identity of a record: changes only when another process takes the entry over. */
const identityOf = (watcher: WatcherRecord | undefined) => watcher && { pid: watcher.pid, port: watcher.port, ownerId: watcher.ownerId }

liveTest(
	'concurrent browsers get distinct stable controls; commands select them explicitly',
	async () => {
		let first: ExtensionHarness | undefined
		let second: ExtensionHarness | undefined
		const sharedHome = await mkdtemp(path.join(os.tmpdir(), 'argus-ext-multi-'))
		try {
			// Launched together: both control hosts race for `extension-control`.
			const started = await Promise.allSettled([
				startExtensionHarness({ registryPath: path.join(sharedHome, 'registry.json') }),
				startExtensionHarness({ registryPath: path.join(sharedHome, 'registry.json') }),
			])
			first = started[0].status === 'fulfilled' ? started[0].value : undefined
			second = started[1].status === 'fulfilled' ? started[1].value : undefined
			for (const result of started) {
				if (result.status === 'rejected') throw result.reason
			}
			if (!first || !second) throw new Error('unreachable')
			expect([first.controlWatcherId, second.controlWatcherId].sort()).toEqual(['extension-control', 'extension-control-2'])

			// PIDs/ports stay put across heartbeats (15 s): no process overwrites the other's entry.
			const before = await readRegistryFile(first.registryPath)
			await delay(16_000)
			const afterHeartbeat = await readRegistryFile(first.registryPath)
			for (const id of [first.controlWatcherId, second.controlWatcherId]) {
				expect(before.watchers[id].extensionRole).toBe('control')
				expect(identityOf(afterHeartbeat.watchers[id])).toEqual(identityOf(before.watchers[id]))
				expect(afterHeartbeat.watchers[id].updatedAt).toBeGreaterThan(before.watchers[id].updatedAt)
			}

			// Each browser profile reports its own persistent instance id.
			const browsers = await first.cliJson<{ browsers: Array<{ instanceId: string | null; controlId: string }> }>('ext', 'browsers', '--json')
			expect(browsers.browsers.map((row) => row.controlId).sort()).toEqual(['extension-control', 'extension-control-2'])
			const instanceIds = browsers.browsers.map((row) => row.instanceId)
			expect(instanceIds.every(Boolean)).toBe(true)
			expect(new Set(instanceIds).size).toBe(2)

			// Without --id, two live controls are ambiguous rather than silently picking one browser.
			const ambiguousTabs = await first.cli('ext', 'tabs', '--json')
			expect(ambiguousTabs.code).toBe(2)
			const ambiguousTabsJson = JSON.parse(ambiguousTabs.stdout) as { error: { code: string }; candidates: Array<{ id: string }> }
			expect(ambiguousTabsJson.error.code).toBe('ambiguous_control')
			expect(ambiguousTabsJson.candidates.map((candidate) => candidate.id).sort()).toEqual(['extension-control', 'extension-control-2'])
			const ambiguousDoctor = await first.cliJson<{ ok: boolean; error: { code: string } | null; candidates: unknown[] }>(
				'ext',
				'doctor',
				'--json',
			)
			expect(ambiguousDoctor.ok).toBe(false)
			expect(ambiguousDoctor.error?.code).toBe('ambiguous_control')
			expect(ambiguousDoctor.candidates).toHaveLength(2)

			const firstTabs = await first.cliJson<{ tabs: Array<{ url: string }> }>('ext', 'tabs', '--id', first.controlWatcherId, '--json')
			const secondTabs = await second.cliJson<{ tabs: Array<{ url: string }> }>('ext', 'tabs', '--id', second.controlWatcherId, '--json')
			expect(firstTabs.tabs.some((tab) => tab.url.includes(first!.pageUrlSubstring))).toBe(true)
			expect(firstTabs.tabs.some((tab) => tab.url.includes(second!.pageUrlSubstring))).toBe(false)
			expect(secondTabs.tabs.some((tab) => tab.url.includes(second!.pageUrlSubstring))).toBe(true)

			const paths = ['/multi-instance/a', '/multi-instance/b']
			const tabIds = await second.evaluateInExtension<number[]>(`(async () => {
			const urls = ${JSON.stringify(paths.map((entry) => second!.pageUrl + entry))};
			const tabs = await Promise.all(urls.map(url => chrome.tabs.create({ url })));
			return tabs.map(tab => tab.id);
		})()`)
			for (const [index, tabId] of tabIds.entries()) {
				const watcherId = `multi-instance-${index}`
				const attached = await second.cli(
					'ext',
					'attach',
					'--id',
					second.controlWatcherId,
					'--tab',
					String(tabId),
					'--as',
					watcherId,
					'--json',
				)
				expect(attached.code).toBe(0)
				const status = await second.cliJson<StatusResponse>('watcher', 'status', watcherId, '--json')
				expect(status.attached).toBe(true)
				expect(status.targetReady).toBe(true)
				const reused = await second.cliJson<{ watcherId: string }>(
					'ext',
					'use',
					'--id',
					second.controlWatcherId,
					'--tab',
					String(tabId),
					'--json',
				)
				expect(reused.watcherId).toBe(watcherId)
			}

			const doctor = await second.cliJson<{ controlWatcher: { id: string }; watcherDiagnostics: { bridge: { watcherId: string } } }>(
				'ext',
				'doctor',
				'--watcher',
				'multi-instance-1',
				'--json',
			)
			expect(doctor.controlWatcher.id).toBe(second.controlWatcherId)
			expect(doctor.watcherDiagnostics.bridge.watcherId).toBe('multi-instance-1')
			const targets = await second.cliJson<{ targets: Array<{ id: string }> }>(
				'ext',
				'targets',
				'--id',
				second.controlWatcherId,
				'--tab',
				String(tabIds[0]),
				'--json',
			)
			expect(targets.targets.some((target) => target.id === `tab:${tabIds[0]}`)).toBe(true)
			expect((await second.cli('ext', 'mute', '--id', second.controlWatcherId, '--tab', String(tabIds[0]), '--json')).code).toBe(0)
			expect((await second.cli('ext', 'unmute', '--id', second.controlWatcherId, '--tab', String(tabIds[0]), '--json')).code).toBe(0)

			const registry = JSON.parse(await readFile(second.registryPath, 'utf8')) as {
				watchers: Record<string, { host: string; port: number }>
			}
			const control = registry.watchers[second.controlWatcherId]
			const failedAttach = await fetch(`http://${control.host}:${control.port}/attach`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tabId: 2_147_483_647, watcherId: 'missing-tab' }),
			}).then((response) => response.json() as Promise<{ ok: boolean; error?: { message: string } }>)
			expect(failedAttach.ok).toBe(false)
			expect(failedAttach.error?.message).toBeTruthy()
			const afterFailure = await second.cliJson<{ tabs: Array<{ watcherId?: string }> }>(
				'ext',
				'tabs',
				'--id',
				second.controlWatcherId,
				'--json',
			)
			expect(afterFailure.tabs.some((tab) => tab.watcherId === 'missing-tab')).toBe(false)
			expect((await second.cli('ext', 'detach', '--id', second.controlWatcherId, '--tab', String(tabIds[0]), '--json')).code).toBe(0)

			// An explicit --as name already bound to another tab is refused, not suffixed.
			const taken = await second.cli(
				'ext',
				'attach',
				'--id',
				second.controlWatcherId,
				'--tab',
				String(tabIds[0]),
				'--as',
				'multi-instance-1',
				'--json',
			)
			expect(taken.code).not.toBe(0)
			expect((JSON.parse(taken.stdout) as { error: { code?: string } }).error.code).toBe('watcher_id_taken')

			// One browser's control host dies (no chance to release its entry) and the extension reconnects:
			// the respawned host reclaims the dead holder's id, and the other browser's entry is untouched.
			// (`chrome.runtime.reload()` would be the graceful variant, but headless Chrome for Testing
			// never restarts the reloaded unpacked worker.)
			const beforeCrash = await readRegistryFile(first.registryPath)
			const crashed = beforeCrash.watchers[first.controlWatcherId]
			const secondControl = identityOf(beforeCrash.watchers[second.controlWatcherId])
			process.kill(crashed.pid, 'SIGKILL')
			const deadline = Date.now() + 45_000
			let respawned: WatcherRecord | undefined
			while (!respawned && Date.now() < deadline) {
				await delay(250)
				const candidate = (await readRegistryFile(first.registryPath)).watchers[first.controlWatcherId]
				if (candidate && candidate.ownerId !== crashed.ownerId) respawned = candidate
			}
			expect(respawned?.extensionRole).toBe('control')
			expect(respawned?.pid).not.toBe(crashed.pid)
			const afterRespawn = await readRegistryFile(first.registryPath)
			expect(identityOf(afterRespawn.watchers[second.controlWatcherId])).toEqual(secondControl)
			expect(Object.values(afterRespawn.watchers).filter((watcher) => watcher.extensionRole === 'control')).toHaveLength(2)
		} finally {
			await second?.close()
			await first?.close()
			await rm(sharedHome, { recursive: true, force: true })
		}
	},
	240_000,
)
