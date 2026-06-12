import type { ErrorResponse, ExtensionDiagnosticsResponse, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatWatcherLine } from '../../output/format.js'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { resolveExtensionWatcher } from './resolveExtensionWatcher.js'
import { getPlatform, inspectNativeHosts } from './nativeHost.js'
import { fetchExtensionTargets, formatExtensionTargetLine, type ExtensionTarget } from './targetSelection.js'

export type ExtensionDoctorOptions = {
	watcher?: string
	json?: boolean
}

export const runExtensionDoctor = async (options: ExtensionDoctorOptions): Promise<void> => {
	const output = createOutput(options)
	const issues: string[] = []
	const hostState = inspectNativeHostState()
	issues.push(...hostState.issues)
	const { configured, hosts } = hostState
	const configuredExtensionId = hosts.find((host) => host.extensionId)?.extensionId ?? null
	const control = await resolveExtensionWatcher({})
	let diagnostics: ExtensionDiagnosticsResponse | null = null
	let watcherDiagnostics: WatcherDiagnostics | null = null

	if (!control.ok) {
		issues.push(control.error)
	} else {
		const result = await fetchExtensionDiagnostics(control.watcher)
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
	if (options.json) {
		output.writeJson({
			ok,
			configured,
			hosts,
			controlWatcher: control.ok ? control.watcher : null,
			diagnostics,
			watcherDiagnostics,
			issues,
		})
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
		for (const watcher of control.candidates ?? []) {
			output.writeHuman(`  ${formatWatcherLine(watcher)}`)
		}
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
			`  Status: attached=${watcherDiagnostics.status?.attached ?? false} targetReady=${watcherDiagnostics.status?.targetReady ?? null}`,
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
	targets: ExtensionTarget[]
	selectedTarget: ExtensionTarget | null
	bridge: ExtensionDiagnosticsResponse['tabWatchers'][number] | null
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

const fetchExtensionDiagnostics = async (
	watcher: WatcherRecord,
): Promise<{ ok: true; diagnostics: ExtensionDiagnosticsResponse } | { ok: false; error: string }> => {
	try {
		const response = await fetchWatcherJson<ExtensionDiagnosticsResponse | ErrorResponse>(watcher, {
			path: '/extension/diagnostics',
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (response.ok) {
			return { ok: true, diagnostics: response }
		}
		return { ok: false, error: response.error.message }
	} catch (error) {
		return { ok: false, error: `${watcher.id}: failed to read extension diagnostics (${formatError(error)})` }
	}
}

const inspectWatcher = async (
	id: string,
	diagnostics: ExtensionDiagnosticsResponse | null,
): Promise<{ ok: true; diagnostics: WatcherDiagnostics; issues: string[] } | { ok: false; error: string }> => {
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		return { ok: false, error: resolved.error }
	}
	if (resolved.watcher.source !== 'extension') {
		return { ok: false, error: `Watcher ${resolved.watcher.id} is not extension-backed.` }
	}

	const [status, targets] = await Promise.all([fetchWatcherStatus(resolved.watcher), fetchExtensionTargets(resolved.watcher)])
	if (!targets.ok) {
		return { ok: false, error: targets.error }
	}

	const selectedTarget = targets.targets.find((target) => target.attached === true) ?? null
	const bridge = diagnostics?.tabWatchers.find((watcher) => watcher.watcherId === resolved.watcher.id) ?? null
	const issues: string[] = []
	if (!status.ok) {
		issues.push(status.error)
	}
	if (!bridge) {
		issues.push(`Watcher ${resolved.watcher.id} is not present in extension diagnostics.`)
	}
	if (status.ok && status.status.attached && !selectedTarget) {
		issues.push(`Watcher ${resolved.watcher.id} is attached, but no selected target was reported by /targets.`)
	}

	return {
		ok: true,
		diagnostics: {
			watcher: resolved.watcher,
			status: status.ok ? status.status : null,
			targets: targets.targets,
			selectedTarget,
			bridge,
		},
		issues,
	}
}

const fetchWatcherStatus = async (watcher: WatcherRecord): Promise<{ ok: true; status: StatusResponse } | { ok: false; error: string }> => {
	try {
		return { ok: true, status: await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_000 }) }
	} catch (error) {
		return { ok: false, error: `${watcher.id}: failed to read status (${formatError(error)})` }
	}
}

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
