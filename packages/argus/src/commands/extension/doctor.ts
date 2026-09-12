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
import { getPlatform, inspectNativeHosts } from './nativeHost.js'
import { formatExtensionTargetLine } from './targetSelection.js'

export type ExtensionDoctorOptions = {
	watcher?: string
	json?: boolean
}

/** Collect partial diagnostics without changing the registry or attempting repair. */
export const collectExtensionDoctor = async (options: ExtensionDoctorOptions = {}) => {
	const issues: string[] = []
	const hostState = inspectNativeHostState()
	issues.push(...hostState.issues)
	const { configured, hosts } = hostState
	const configuredExtensionId = hosts.find((host) => host.extensionId)?.extensionId ?? null
	const layerEvidence = await inspectDoctorLayers()
	issues.push(...layerEvidence.warnings)
	for (const layer of layerEvidence.layers) {
		if (layer.registryIdentityMatches === false) issues.push(`Registry entry ${layer.watcher.id} points at a different responding watcher.`)
	}
	const controlWatcher = layerEvidence.layers.find((layer) => layer.watcher.id === 'extension-control')?.watcher
	const control = controlWatcher
		? { ok: true as const, watcher: controlWatcher }
		: { ok: false as const, error: 'No extension control watcher in registry; worker startup/registration is unknown.' }
	let diagnostics: ExtensionDiagnosticsResponse | null = null
	let controlRequest: DiagnosticTrace | null = null
	let watcherDiagnostics: WatcherDiagnostics | null = null

	if (!control.ok) {
		issues.push(control.error)
	} else {
		const result = await fetchExtensionDiagnostics(control.watcher)
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
