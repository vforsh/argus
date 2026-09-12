import { readRegistry, type ApiResult, type StatusResponse, type WatcherRecord } from '@vforsh/argus-core'
import { diagnosticRequest } from './diagnosticRequest.js'

/** Observe local process existence without confusing a reused PID with host identity. */
export function processExists(pid: number): boolean | null {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null
	}
}

/** Read without pruning: a stale registry entry is incident evidence. Probe each transport independently. */
export async function inspectDoctorLayers() {
	const { registry, warnings } = await readRegistry()
	const watchers = Object.values(registry.watchers).filter((watcher) => watcher.source === 'extension')
	const layers = await Promise.all(watchers.slice(0, 32).map(probeWatcher))
	return { layers, warnings: [...warnings, ...(watchers.length > 32 ? ['Only first 32 extension transports probed.'] : [])] }
}

async function probeWatcher(watcher: WatcherRecord) {
	const alive = ['127.0.0.1', 'localhost', '::1'].includes(watcher.host) ? processExists(watcher.pid) : null
	const probe = await diagnosticRequest<ApiResult<StatusResponse>>(watcher, '/status', 1000)
	const status = probe.ok && probe.response?.ok ? probe.response : null
	const identityMatches =
		status && typeof status.pid === 'number' && typeof status.id === 'string' ? status.pid === watcher.pid && status.id === watcher.id : null
	return {
		watcher,
		...probe.trace,
		processExists: alive,
		registryIdentityMatches: identityMatches,
		processIdentity: describeProcessIdentity(identityMatches),
		nativeHostVersion: status?.watcherVersion ?? null,
		httpProtocolVersion: status?.protocolVersion ?? null,
		registryAgeMs: Date.now() - watcher.updatedAt,
		transport: probe.ok ? 'responded' : 'unreachable-or-unresponsive',
		staleRegistry: alive === false || identityMatches === false,
		attachment: status?.attached ?? null,
		targetReady: status?.targetReady ?? null,
		execution: 'not tested',
	}
}

function describeProcessIdentity(identityMatches: boolean | null): string {
	if (identityMatches === true) return 'HTTP identity matches registry PID and id'
	if (identityMatches === false) return 'HTTP identity differs from registry PID or id'
	return 'PID existence only; not proof of executable identity'
}
