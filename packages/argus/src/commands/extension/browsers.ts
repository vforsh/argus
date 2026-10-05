import { createOutput } from '../../output/io.js'
import { pruneRegistry } from '../../registry.js'
import { readBrowserLabels, setBrowserLabel, type BrowserLabel } from './browserLabels.js'
import { emitFailure } from './failures.js'
import { getBrowserInstanceId, probeControls, type LiveControl } from './liveControls.js'
import { fetchExtensionTabs } from './tabSelection.js'

/** One browser running the extension, as seen through its control watcher. */
export type ExtensionBrowserRow = {
	/** Persistent per-profile id; `null` when the extension is too old to report one, or its control is unreachable. */
	instanceId: string | null
	/** Assigned label, or `null` while ownership is unverified. */
	label: string | null
	labelSource: BrowserLabel['source'] | null
	controlId: string
	controlPid: number
	/** `connected`: control answers and its extension bridge is up. `unreachable`: state unknown. */
	state: 'connected' | 'disconnected' | 'unreachable'
	extensionVersion: string | null
	hostVersion: string | null
	tabCount: number | null
}

/** List one row per browser instance (one per control watcher). */
export const collectExtensionBrowsers = async (): Promise<ExtensionBrowserRow[]> => {
	const registry = await pruneRegistry()
	const [probe, labels] = await Promise.all([probeControls(Object.values(registry.watchers), { browser: true }), readBrowserLabels()])
	const live = await Promise.all(probe.live.map((control) => toRow(control, labels)))
	const unreachable: ExtensionBrowserRow[] = probe.unreachable.map(({ watcher }) => ({
		instanceId: null,
		label: null,
		labelSource: null,
		controlId: watcher.id,
		controlPid: watcher.pid,
		state: 'unreachable',
		extensionVersion: null,
		hostVersion: null,
		tabCount: null,
	}))
	return [...live, ...unreachable].sort((a, b) => a.controlId.localeCompare(b.controlId))
}

const toRow = async (control: LiveControl, labels: Record<string, BrowserLabel>): Promise<ExtensionBrowserRow> => {
	const instanceId = getBrowserInstanceId(control)
	const label = instanceId ? labels[instanceId] : undefined
	const tabs = await fetchExtensionTabs(control.watcher, { kind: 'query' })
	return {
		instanceId,
		label: label?.label ?? null,
		labelSource: label?.source ?? null,
		controlId: control.watcher.id,
		controlPid: control.watcher.pid,
		state: control.diagnostics?.control.connected ? 'connected' : 'disconnected',
		extensionVersion: control.diagnostics?.extension.version ?? null,
		hostVersion: control.watcherVersion,
		tabCount: tabs.ok ? tabs.tabs.length : null,
	}
}

export const runExtensionBrowsers = async (options: { json?: boolean }): Promise<void> => {
	const output = createOutput(options)
	const rows = await collectExtensionBrowsers()
	if (options.json) {
		output.writeJson({ ok: true, browsers: rows })
		return
	}
	if (rows.length === 0) {
		output.writeHuman('No browsers with a registered extension control watcher.')
		return
	}
	for (const row of rows) {
		const label = row.label ? `${row.label} (${row.labelSource})` : 'unlabeled'
		const tabs = row.tabCount == null ? '' : ` tabs=${row.tabCount}`
		output.writeHuman(`${row.instanceId ?? 'unknown-instance'}  ${label}`)
		output.writeHuman(
			`  ${row.controlId} pid=${row.controlPid} ${row.state} extension=${row.extensionVersion ?? '?'} host=${row.hostVersion ?? '?'}${tabs}`,
		)
	}
}

/**
 * Label a live browser instance. The label is how commands select it (`--browser <label>`), so it
 * must name an instance that answers right now; `ext bind --label` labels the bound browser instead.
 */
export const runExtensionBrowserLabel = async (instanceId: string, label: string, options: { json?: boolean }): Promise<void> => {
	const output = createOutput(options)
	const trimmed = label.trim()
	if (!trimmed) {
		emitFailure(output, { error: 'Label must be non-empty.', code: 'invalid_request', exitCode: 2 })
		return
	}

	const rows = await collectExtensionBrowsers()
	const row = rows.find((candidate) => candidate.instanceId === instanceId)
	if (!row) {
		const known = rows.flatMap((candidate) => (candidate.instanceId ? [candidate.instanceId] : []))
		emitFailure(output, {
			error: `No live browser instance ${instanceId}. Known: ${known.length > 0 ? known.join(', ') : 'none'}.`,
			code: 'not_found',
			exitCode: 2,
		})
		return
	}

	await setBrowserLabel(instanceId, trimmed, 'manual')
	if (options.json) {
		output.writeJson({ ok: true, instanceId, label: trimmed, controlId: row.controlId })
		return
	}
	output.writeHuman(`labeled ${instanceId} as ${trimmed} (${row.controlId})`)
}
