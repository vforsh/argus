import packageJson from '../../package.json' with { type: 'json' }
import {
	appendLifecycleEvent,
	normalizeLifecycleEvent,
	shouldJournalMessage,
	errorEvidence,
	messageEvidence,
	NATIVE_MESSAGING_PROTOCOL_VERSION,
	type LifecycleEvent,
} from '@vforsh/argus-core'
import { randomUUID } from 'node:crypto'

const session = randomUUID()
let installed = false
const mirrored = new Set<string>()

/** Native-side observation survives worker loss; EOF is evidence of channel closure, not its cause. */
export function recordNative(operation: string, detail: LifecycleEvent['detail'] = {}): void {
	if (!installed) return
	appendLifecycleEvent({ ts: Date.now(), session, operation, detail: { pid: process.pid, ...detail } })
}

/** Record message metadata and mirror the worker's bounded journal without any page payload. */
export function recordNativeMessage(operation: string, message: unknown): void {
	const metadata = messageEvidence(message)
	if (shouldJournalMessage(metadata)) recordNative(operation, metadata)
	const value = message as { diagnostics?: { journal?: LifecycleEvent[] } }
	if (metadata.type !== 'control_status_response' || !Array.isArray(value.diagnostics?.journal)) return
	for (const candidate of value.diagnostics.journal.slice(-128)) {
		const event = normalizeLifecycleEvent(candidate)
		if (!event) continue
		const key = `${event.session}:${event.ts}:${event.operation}:${JSON.stringify(event.detail)}`
		if (mirrored.has(key)) continue
		mirrored.add(key)
		appendLifecycleEvent(event)
	}
	if (mirrored.size > 512) {
		const keep = [...mirrored].slice(-128)
		mirrored.clear()
		for (const key of keep) mirrored.add(key)
	}
}

/** Install once per host; monitor errors without swallowing them or changing exit semantics. */
export function startNativeJournal(): void {
	if (installed) return
	installed = true
	recordNative('host.start', {
		protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
		runtime: process.version,
		nativeHostVersion: packageJson.version,
		parentPid: process.ppid,
	})
	process.on('exit', (code) => recordNative('host.exit', { code }))
	process.on('uncaughtExceptionMonitor', (error) => recordNative('host.uncaught', errorEvidence(error)))
}
