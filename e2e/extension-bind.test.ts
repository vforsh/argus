/**
 * Exact tab binding through one-time tickets and browser identity
 * (issue #18, phases 2–5), against a real Chromium with the unpacked extension.
 *
 * The extension service worker stands in for the agent's browser API: it opens the bindUrl in a
 * background tab, the way Codex's browser would, and the test then binds by ticket alone.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { delay, type RegistryV1 } from '@vforsh/argus-core'
import { resolveTestChromeBin, startExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness.js'

const liveTest = resolveTestChromeBin() ? test : test.skip
if (!resolveTestChromeBin()) console.warn('[extension-bind] No Chromium binary; skipping real-browser check.')

type Prepared = { ticket: string; bindUrl: string; destination: string; expiresAt: number }
type BindResult = {
	ok: true
	watcherId: string
	tabId: number
	url: string
	control: { id: string; pid: number }
	browser: { instanceId: string | null; label: string | null }
	attached: boolean
	reused: boolean
	targetReady: boolean | null
	visibility: string
}
type Failure = { ok: false; error: { message: string; code?: string } }
type BrowsersList = { browsers: Array<{ instanceId: string | null; label: string | null; controlId: string; state: string }> }

let harness: ExtensionHarness

beforeAll(async () => {
	if (resolveTestChromeBin()) harness = await startExtensionHarness()
}, 90_000)

afterAll(async () => {
	await harness?.close()
})

const prepare = (destination: string) => harness.cliJson<Prepared>('ext', 'bind', 'prepare', '--to', destination, '--json')

/** Open a URL in a new background tab, as an agent's browser API would. */
const openTab = (url: string) =>
	harness.evaluateInExtension<number>(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }).then(tab => tab.id)`)

const closeTab = (tabId: number) => harness.evaluateInExtension(`chrome.tabs.remove(${tabId}).then(() => true)`)

/** Wait until the extension reports the tab at a URL containing `substring` (tab URLs settle after load). */
const waitForTabUrl = async (tabId: number, substring: string): Promise<void> => {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		const url = await harness.evaluateInExtension<string>(`chrome.tabs.get(${tabId}).then(tab => tab.url ?? '')`)
		if (url.includes(substring)) return
		await delay(100)
	}
	throw new Error(`Tab ${tabId} never reached ${substring}`)
}

const bindJson = async <T>(...args: string[]): Promise<{ code: number | null; json: T }> => {
	const result = await harness.cli('ext', 'bind', ...args, '--json')
	return { code: result.code, json: JSON.parse(result.stdout) as T }
}

const readRegistryFile = (): RegistryV1 => JSON.parse(fs.readFileSync(harness.registryPath, 'utf8')) as RegistryV1

liveTest(
	'binds exactly the ticket tab among same-URL tabs; rebinding reuses; tickets fail explicitly',
	async () => {
		const destination = `${harness.pageUrl}?bind-test=1`
		// Another tab already sits at the destination URL: URL matching alone would be ambiguous.
		const decoy = await openTab(destination)

		const first = await prepare(destination)
		expect(first.ticket).toStartWith('argus-bind-')
		expect(first.bindUrl).toContain(first.ticket)
		const tabId = await openTab(first.bindUrl)
		await waitForTabUrl(tabId, first.ticket)

		const bound = await bindJson<BindResult>(first.ticket, '--as', 'bound', '--label', 'codex', '--visibility', 'background')
		expect(bound.code).toBe(0)
		expect(bound.json).toMatchObject({
			ok: true,
			watcherId: 'bound',
			tabId,
			attached: true,
			reused: false,
			targetReady: true,
			visibility: 'background',
			control: { id: harness.controlWatcherId },
			browser: { label: 'codex' },
		})
		expect(bound.json.url).toBe(first.destination)
		expect(bound.json.browser.instanceId).toBeTruthy()

		const used = await bindJson<Failure>(first.ticket)
		expect(used.code).toBe(2)
		expect(used.json.error.code).toBe('bind_ticket_used')

		// Same tab, new ticket: the existing watcher is reused, nothing detached.
		const second = await prepare(destination)
		await harness.evaluateInExtension(`chrome.tabs.update(${tabId}, { url: ${JSON.stringify(second.bindUrl)} }).then(() => true)`)
		await waitForTabUrl(tabId, second.ticket)
		const rebound = await bindJson<BindResult>(second.ticket, '--as', 'bound')
		expect(rebound.code).toBe(0)
		expect(rebound.json).toMatchObject({ watcherId: 'bound', tabId, reused: true, targetReady: true })

		// One ticket open in two tabs: refuse to pick.
		const third = await prepare(destination)
		const twins = [await openTab(third.bindUrl), await openTab(third.bindUrl)]
		for (const twin of twins) await waitForTabUrl(twin, third.ticket)
		const ambiguous = await bindJson<Failure & { matches: unknown[] }>(third.ticket)
		expect(ambiguous.code).toBe(2)
		expect(ambiguous.json.error.code).toBe('ambiguous_tab')
		expect(ambiguous.json.matches).toHaveLength(2)
		for (const twin of twins) await closeTab(twin)

		// Expired: age the stored ticket instead of waiting a minute.
		const fourth = await prepare(destination)
		const ticketsPath = path.join(path.dirname(harness.registryPath), 'bind-tickets.json')
		const store = JSON.parse(fs.readFileSync(ticketsPath, 'utf8'))
		store.tickets[fourth.ticket].expiresAt = Date.now() - 1
		fs.writeFileSync(ticketsPath, JSON.stringify(store))
		const expired = await bindJson<Failure>(fourth.ticket)
		expect(expired.code).toBe(2)
		expect(expired.json.error.code).toBe('bind_ticket_expired')

		// Never opened: not found, naming the controls that were searched.
		const fifth = await prepare(destination)
		const missing = await bindJson<Failure & { searched: string[] }>(fifth.ticket)
		expect(missing.json.error.code).toBe('not_found')
		expect(missing.json.searched).toEqual([harness.controlWatcherId])

		// The label selects this browser; closing the bound tab releases its watcher.
		const labeled = await harness.cli('ext', 'tabs', '--browser', 'codex', '--json')
		expect(labeled.code).toBe(0)
		await closeTab(tabId)
		const deadline = Date.now() + 10_000
		while (readRegistryFile().watchers.bound && Date.now() < deadline) await delay(200)
		expect(readRegistryFile().watchers.bound).toBeUndefined()
		await closeTab(decoy)
	},
	120_000,
)

liveTest(
	'browser instance id and label survive a browser restart',
	async () => {
		const before = await harness.cliJson<BrowsersList>('ext', 'browsers', '--json')
		expect(before.browsers).toHaveLength(1)
		const [instance] = before.browsers
		expect(instance).toMatchObject({ label: 'codex', controlId: harness.controlWatcherId, state: 'connected' })
		expect(instance.instanceId).toBeTruthy()

		await harness.restart()
		const after = await harness.cliJson<BrowsersList>('ext', 'browsers', '--json')
		expect(after.browsers.map((row) => row.instanceId)).toEqual([instance.instanceId])
		expect(after.browsers[0].label).toBe('codex')
	},
	120_000,
)
