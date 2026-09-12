import { enableExtensionDeveloperMode } from './helpers/extensionDeveloperMode.js'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'

const chromeBin = resolveTestChromeBin()
const liveTest = chromeBin ? test : test.skip
if (!chromeBin) console.warn('[extension-diagnostics] No real Chromium binary: reload/crash/idle observations SKIPPED.')
let harness: ExtensionHarness
let root: string
beforeAll(async () => {
	if (!chromeBin) return
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-incidents-'))
	harness = await startExtensionHarness()
	await enableExtensionDeveloperMode(harness.cdpAddress)
}, 120000)
afterAll(async () => {
	await harness?.close()
	if (root) fs.rmSync(root, { recursive: true, force: true })
})

type Doctor = { diagnostics: { control: { connected: boolean; pid: number }; journal: Array<{ session: string; operation: string }> } | null }

liveTest(
	'real reload and native-host crash preserve evidence and recover after idle without keepalive requests',
	async () => {
		const before = await harness.cliJson<Doctor>('ext', 'doctor', '--json')
		expect(before.diagnostics?.control.connected).toBe(true)
		// Wait for the preceding boot to reach storage before issuing a supported runtime reload.
		await new Promise((resolve) => setTimeout(resolve, 500))
		await harness.evaluateInExtension('setTimeout(() => chrome.runtime.reload(), 100); true')
		// No CLI requests or worker DevTools session for 40s. Native ports may keep the worker alive;
		// this verifies idle recovery, not forced suspension or a claim about Chrome's termination policy.
		await new Promise((resolve) => setTimeout(resolve, 40000))
		const reloaded = await harness.cliJson<Doctor>('ext', 'doctor', '--json')
		expect(reloaded.diagnostics?.control.connected).toBe(true)
		const boots = reloaded.diagnostics!.journal.filter((event) => event.operation === 'worker.boot')
		expect(new Set(boots.map((event) => event.session)).size).toBeGreaterThanOrEqual(2)
		const pid = reloaded.diagnostics!.control.pid
		process.kill(pid, 'SIGKILL') // Real isolated native host crash. No simulation of messaging here.
		await new Promise((resolve) => setTimeout(resolve, 40000))
		const recovered = await harness.cliJson<Doctor>('ext', 'doctor', '--json')
		expect(recovered.diagnostics?.control.connected).toBe(true)
		expect(recovered.diagnostics?.control.pid).not.toBe(pid)
		const out = path.join(root, 'after-crash')
		const bundle = await harness.cli('ext', 'diagnose', '--out', out, '--json')
		expect(bundle.code).toBe(0)
		const evidence = fs.readFileSync(path.join(out, 'incident.json'), 'utf8')
		expect(evidence).toContain('bridge.disconnected')
		expect(evidence).toContain('bridge.reconnect.scheduled')
		expect(evidence).toContain('wrapper.start')
		// Recovery checks execution independently from the control transport, on a real tab.
		const tabId = await harness.evaluateInExtension<number>(
			`(async () => (await chrome.tabs.query({})).find(t => t.url.includes(${JSON.stringify(harness.pageUrlSubstring)})).id)()`,
		)
		const result = await harness.cliJson<{ controlReady: boolean; attachment: boolean; execution: string }>(
			'ext',
			'recover',
			'--tab',
			String(tabId),
			'--watcher',
			'diagnostic-test',
			'--out',
			path.join(root, 'recovery'),
			'--json',
		)
		expect(result).toMatchObject({ controlReady: true, attachment: true, execution: 'passed' })
	},
	120000,
)
