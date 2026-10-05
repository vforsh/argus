import { diagnosticRequest, type DiagnosticTrace } from './diagnosticRequest.js'
import { formatError } from '../../cli/parse.js'
import type {
	ExtensionDiagnosticsResponse,
	ExtensionTargetsResponse,
	StatusResponse,
	WatcherRecord,
	ExtensionTargetSummary,
	ApiResult,
} from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatWatcherLine } from '../../output/format.js'
import { loadRegistry } from '../../registry.js'
import { inspectDoctorLayers } from './doctorLayers.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import { detectHostVersionSkew, formatHostVersionSkew } from '../../watchers/versionSkew.js'
import { getPlatform, inspectNativeHosts } from './nativeHost.js'
import { formatExtensionTargetLine } from './targetSelection.js'

export type ExtensionDoctorOptions = {
	id?: string
	/** Browser label or instance id; resolved to its control watcher id. */
	browser?: string
	watcher?: string
	json?: boolean
}

/** Collect partial diagnostics without changing the registry or attempting repair. */
export const collectExtensionDoctor = async (options: ExtensionDoctorOptions = {}) => {
	const issues: string[] = []
	const requested = await resolveRequestedControl(options)
	const controlId = requested.ok ? requested.id : undefined
	const hostState = inspectNativeHostState()
	issues.push(...hostState.issues)
	const { configured, hosts } = hostState
	const configuredExtensionId = hosts.find((host) => host.extensionId)?.extensionId ?? null
	const layerEvidence = await inspectDoctorLayers()
	issues.push(...layerEvidence.warnings)
	const versionSkew = layerEvidence.layers.flatMap((layer) => detectHostVersionSkew(layer.watcher, layer.nativeHostVersion) ?? [])
	issues.push(...versionSkew.map(formatHostVersionSkew))
	for (const layer of layerEvidence.layers) {
		if (layer.registryIdentityMatches === false) issues.push(`Registry entry ${layer.watcher.id} points at a different responding watcher.`)
		if (layer.legacyRegistration && layer.transport === 'responded') {
			issues.push(
				`Watcher ${layer.watcher.id} was registered by an older native host that can overwrite other watchers' entries. Reload the extension at chrome://extensions or restart the browser to respawn native hosts.`,
			)
		}
	}
	const controlLayers: typeof layerEvidence.layers = []
	const seenTransports = new Set<string>()
	for (const layer of layerEvidence.layers) {
		if (!layer.controlTransport) continue
		const address = `${layer.watcher.host}:${layer.watcher.port}`
		if (seenTransports.has(address)) continue
		seenTransports.add(address)
		controlLayers.push(layer)
	}
	const controlResults =
		options.watcher && requested.ok && !controlId
			? await Promise.all(
					controlLayers.map(async (layer) => ({ watcher: layer.watcher, result: await fetchExtensionDiagnostics(layer.watcher) })),
				)
			: []
	const owners = controlResults.filter(
		(entry) => entry.result.ok && entry.result.diagnostics.tabWatchers.some((tab) => tab.watcherId === options.watcher),
	)
	if (owners.length > 1) issues.push(`Watcher ${options.watcher} is reported by multiple control watchers; specify --id.`)
	const selection = requested.ok ? selectControlWatcher(controlLayers, owners, controlId) : {}
	const control = selection.watcher
		? { ok: true as const, watcher: selection.watcher }
		: { ok: false as const, error: describeMissingControl(requested, selection) }
	let diagnostics: ExtensionDiagnosticsResponse | null = null
	let controlRequest: DiagnosticTrace | null = null
	let watcherDiagnostics: WatcherDiagnostics | null = null

	if (!control.ok) {
		issues.push(control.error)
	} else {
		const result =
			controlResults.find((entry) => entry.watcher.id === control.watcher.id)?.result ?? (await fetchExtensionDiagnostics(control.watcher))
		controlRequest = result.trace
		if (result.ok) {
			diagnostics = result.diagnostics
		} else {
			issues.push(result.error)
		}
	}
	if (options.watcher) {
		const result = await inspectWatcher(options.watcher, diagnostics)
		if (result.ok) {
			watcherDiagnostics = result.diagnostics
			issues.push(...result.issues)
		} else {
			issues.push(result.error)
		}
	}

	if (configuredExtensionId && diagnostics?.extension.id && configuredExtensionId !== diagnostics.extension.id) {
		issues.push(`Native host is configured for ${configuredExtensionId}, but the connected extension is ${diagnostics.extension.id}.`)
	}
	if (diagnostics && !diagnostics.control.connected) {
		issues.push('Extension control bridge is disconnected.')
	}

	const ok = issues.length === 0
	return {
		ok,
		/** Set when doctor could not pick a control watcher on its own; `candidates` lists the choices. */
		error: selection.ambiguous ? { message: selection.ambiguous.message, code: 'ambiguous_control' as const } : null,
		candidates: selection.ambiguous?.candidates.map(({ id, pid, host, port }) => ({ id, pid, host, port })) ?? [],
		/** Hosts running a different watcher build than this CLI (respawn them to upgrade). */
		versionSkew,
		configured,
		hosts,
		controlWatcher: control.ok ? control.watcher : null,
		diagnostics,
		watcherDiagnostics,
		issues,
		controlRequest,
		layers: layerEvidence.layers,
		workerState:
			'Registration, suspension and process state unavailable through extension API. Collect Chrome extension Errors and serviceworker-internals before reload; optional CDP requires a debugging-enabled browser.',
	}
}

/**
 * The control `--id` or `--browser` asks for (`id` undefined: none requested). A `--browser` that
 * resolves to no single browser is an error, never a fallback to another browser.
 */
const resolveRequestedControl = async (options: ExtensionDoctorOptions): Promise<{ ok: true; id?: string } | { ok: false; error: string }> => {
	if (!options.browser) return { ok: true, id: options.id }
	const resolved = await resolveExtensionWatcher(options)
	return resolved.ok ? { ok: true, id: resolved.watcher.id } : { ok: false, error: resolved.error }
}

const describeMissingControl = (
	requested: Awaited<ReturnType<typeof resolveRequestedControl>>,
	selection: ReturnType<typeof selectControlWatcher>,
): string => {
	if (!requested.ok) return requested.error
	if (requested.id) return `Control watcher ${requested.id} is unavailable or is not a control watcher.`
	return selection.ambiguous?.message ?? 'No extension control watcher in registry; worker startup/registration is unknown.'
}

type DoctorLayer = Awaited<ReturnType<typeof inspectDoctorLayers>>['layers'][number]

/**
 * Pick the control to diagnose: `--id`, else the single control that owns `--watcher`, else the
 * only live control. Several live controls with nothing to choose between them is ambiguous —
 * defaulting to `extension-control` silently diagnosed whichever browser registered first.
 */
const selectControlWatcher = (
	controlLayers: DoctorLayer[],
	owners: Array<{ watcher: WatcherRecord }>,
	id: string | undefined,
): { watcher?: WatcherRecord; ambiguous?: { message: string; candidates: WatcherRecord[] } } => {
	if (id) return { watcher: controlLayers.find((layer) => layer.watcher.id === id)?.watcher }
	if (owners.length === 1) return { watcher: owners[0].watcher }

	const live = controlLayers.filter((layer) => layer.transport === 'responded' && layer.registryIdentityMatches !== false)
	if (live.length === 1) return { watcher: live[0].watcher }
	if (live.length === 0) return {}

	const candidates = live.map((layer) => layer.watcher)
	return {
		ambiguous: {
			message: `Multiple extension control watchers are live (${candidates.map((watcher) => watcher.id).join(', ')}); one per browser. Pass --id <controlWatcherId> to pick one.`,
			candidates,
		},
	}
}

export const runExtensionDoctor = async (options: ExtensionDoctorOptions): Promise<void> => {
	const output = createOutput(options)
	const result = await collectExtensionDoctor(options)
	const { ok, configured, hosts, diagnostics, watcherDiagnostics, issues } = result
	const configuredExtensionId = hosts.find((host) => host.extensionId)?.extensionId ?? null
	const control = result.controlWatcher
		? { ok: true as const, watcher: result.controlWatcher }
		: { ok: false as const, error: 'Control watcher unavailable' }
	if (options.json) {
		output.writeJson(result)
		if (!ok) {
			process.exitCode = 1
		}
		return
	}

	output.writeHuman(ok ? 'Extension control looks healthy' : 'Extension control has issues')
	output.writeHuman('')
	output.writeHuman(`Native hosts: ${configured ? 'configured' : 'incomplete'}`)
	for (const host of hosts) {
		output.writeHuman(`  ${host.hostName}: ${host.configured ? 'ok' : 'broken'}`)
	}
	if (configuredExtensionId) {
		output.writeHuman(`  configured extension: ${configuredExtensionId}`)
	}

	output.writeHuman('')
	if (control.ok) {
		output.writeHuman(`Control watcher: ${formatWatcherLine(control.watcher)}`)
	} else {
		output.writeHuman(`Control watcher: ${control.error}`)
	}

	if (diagnostics) {
		output.writeHuman(`Runtime extension: ${diagnostics.extension.id ?? 'unknown'} ${diagnostics.extension.version ?? ''}`.trim())
		output.writeHuman(`Control bridge: ${diagnostics.control.connected ? 'connected' : 'disconnected'}`)
		output.writeHuman(`Tab watchers: ${diagnostics.tabWatchers.length}`)
		for (const watcher of diagnostics.tabWatchers) {
			output.writeHuman(
				`  ${watcher.tabId}: ${watcher.watcherId ?? 'unknown'} ${watcher.targetReady === false ? '(target pending)' : ''}`.trim(),
			)
		}
	}

	if (watcherDiagnostics) {
		output.writeHuman('')
		output.writeHuman(`Watcher ${watcherDiagnostics.watcher.id}:`)
		output.writeHuman(
			`  Status: attached=${watcherDiagnostics.status?.attached ?? 'unknown'} targetReady=${watcherDiagnostics.status?.targetReady ?? null}`,
		)
		if (watcherDiagnostics.selectedTarget) {
			output.writeHuman(`  Selected: ${formatExtensionTargetLine(watcherDiagnostics.selectedTarget)}`)
		}
		if (watcherDiagnostics.bridge) {
			output.writeHuman(
				`  Bridge: connected=${watcherDiagnostics.bridge.connected} tab=${watcherDiagnostics.bridge.tabId} pid=${watcherDiagnostics.bridge.pid ?? 'unknown'}`,
			)
		}
		output.writeHuman(`  Targets: ${watcherDiagnostics.targets.length}`)
	}

	if (issues.length > 0) {
		output.writeHuman('')
		output.writeHuman('Issues:')
		for (const issue of issues) {
			output.writeHuman(`  ${issue}`)
		}
		process.exitCode = 1
	}
}

type WatcherDiagnostics = {
	watcher: WatcherRecord
	status: StatusResponse | null
	targets: ExtensionTargetSummary[]
	selectedTarget: ExtensionTargetSummary | null
	bridge: ExtensionDiagnosticsResponse['tabWatchers'][number] | null
	requests: DiagnosticTrace[]
}

const inspectNativeHostState = (): { configured: boolean; hosts: ReturnType<typeof inspectNativeHosts>; issues: string[] } => {
	try {
		const hosts = inspectNativeHosts(getPlatform())
		const configured = hosts.length > 0 && hosts.every((host) => host.configured)
		return {
			configured,
			hosts,
			issues: configured ? [] : ['Native messaging hosts are not fully configured.'],
		}
	} catch (error) {
		return { configured: false, hosts: [], issues: [formatError(error)] }
	}
}

const fetchExtensionDiagnostics = async (watcher: WatcherRecord) => {
	const result = await diagnosticRequest<ApiResult<ExtensionDiagnosticsResponse>>(watcher, '/extension/diagnostics', 6000)
	if (!result.ok) return result
	if (!result.response?.ok)
		return { ok: false as const, error: result.response?.error?.message ?? 'Invalid diagnostics response', trace: result.trace }
	if (!result.response.control || !result.response.extension || !Array.isArray(result.response.tabWatchers)) {
		return { ok: false as const, error: 'Invalid diagnostics response; worker readiness unknown', trace: result.trace }
	}
	return { ok: true as const, diagnostics: result.response, trace: result.trace }
}

const inspectWatcher = async (
	id: string,
	diagnostics: ExtensionDiagnosticsResponse | null,
): Promise<{ ok: true; diagnostics: WatcherDiagnostics; issues: string[] } | { ok: false; error: string }> => {
	const registry = await loadRegistry()
	const watcher = registry.watchers[id]
	const resolved = watcher ? { ok: true as const, watcher } : { ok: false as const, error: `Watcher not found: ${id}` }
	if (!resolved.ok) {
		return { ok: false, error: resolved.error }
	}
	if (resolved.watcher.source !== 'extension') {
		return { ok: false, error: `Watcher ${resolved.watcher.id} is not extension-backed.` }
	}

	const [status, targets] = await Promise.all([fetchWatcherStatus(resolved.watcher), fetchWatcherTargets(resolved.watcher)])
	const availableTargets = targets.ok ? targets.targets : []
	const selectedTarget = availableTargets.find((target) => target.attached === true) ?? null
	const bridge = diagnostics?.tabWatchers.find((watcher) => watcher.watcherId === resolved.watcher.id) ?? null
	const issues: string[] = targets.ok ? [] : [targets.error]
	if (!status.ok) {
		issues.push(status.error)
	}
	if (!bridge) {
		issues.push(`Watcher ${resolved.watcher.id} is not present in extension diagnostics.`)
	} else if (!bridge.connected) {
		issues.push(`Watcher ${resolved.watcher.id} native bridge is disconnected.`)
	}
	if (status.ok && !status.status.attached) {
		issues.push(`Watcher ${resolved.watcher.id} has no debugger-attached target.`)
	}
	if (status.ok && status.status.targetReady === false) {
		issues.push(`Watcher ${resolved.watcher.id} selected target is not ready for commands.`)
	}
	if (status.ok && status.status.attached && !selectedTarget) {
		issues.push(`Watcher ${resolved.watcher.id} is attached, but no selected target was reported by /targets.`)
	}

	return {
		ok: true,
		diagnostics: {
			watcher: resolved.watcher,
			status: status.ok ? status.status : null,
			targets: availableTargets,
			selectedTarget,
			bridge,
			requests: [status.trace, targets.trace],
		},
		issues,
	}
}

const fetchWatcherStatus = async (watcher: WatcherRecord) => {
	const result = await diagnosticRequest<ApiResult<StatusResponse>>(watcher, '/status', 1000)
	if (!result.ok) return result
	if (!result.response?.ok) return { ok: false as const, error: result.response?.error?.message ?? 'Invalid status response', trace: result.trace }
	return { ok: true as const, status: result.response, trace: result.trace }
}

const fetchWatcherTargets = async (watcher: WatcherRecord) => {
	const result = await diagnosticRequest<ApiResult<ExtensionTargetsResponse>>(watcher, '/targets', 5000)
	if (!result.ok) return result
	if (!result.response?.ok) return { ok: false as const, error: result.response?.error?.message ?? 'Invalid targets response', trace: result.trace }
	if (!Array.isArray(result.response.targets))
		return { ok: false as const, error: 'Invalid targets response; target readiness unknown', trace: result.trace }
	return { ok: true as const, targets: result.response.targets, trace: result.trace }
}
