import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { StatusResponse } from '@vforsh/argus-core'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'

const liveTest = resolveTestChromeBin() ? test : test.skip
if (!resolveTestChromeBin()) console.warn('[extension-multi-instance] No Chromium binary; skipping real-browser check.')

liveTest(
	'selects the second extension instance and waits for consecutive tab attachments',
	async () => {
		let first: ExtensionHarness | undefined
		let second: ExtensionHarness | undefined
		try {
			first = await startExtensionHarness()
			second = await startExtensionHarness({ registryPath: first.registryPath, controlWatcherId: 'extension-control-2' })

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
		} finally {
			await second?.close()
			await first?.close()
		}
	},
	180_000,
)
