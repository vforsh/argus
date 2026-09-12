import { errorEvidence, normalizeLifecycleEvent, type LifecycleEvent } from '@vforsh/argus-core/diagnostic-events'
import { NATIVE_MESSAGING_PROTOCOL_VERSION } from '../types/messages.js'

const KEY = 'argus.lifecycle.v1'
const MAX_EVENTS = 128
const session = crypto.randomUUID()
let events: LifecycleEvent[] = []
let pending: LifecycleEvent[] = []
let sink: (() => void) | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushing: Promise<void> | undefined
let loaded = false
let sequence = 0

/** Append bounded metadata. No periodic keepalive: writes and mirrors run only in response to actual events. */
export function recordLifecycle(operation: string, detail: LifecycleEvent['detail'] = {}): void {
	const event = normalizeLifecycleEvent({ ts: Date.now(), session, operation, detail: { ...detail, sequence: ++sequence } })
	if (!event) return
	pending = [...pending, event].slice(-MAX_EVENTS)
	void flushLifecycleJournal()
}

/** Flush pending evidence in order. Exposed for handshake/tests; persistence is not guaranteed on abrupt termination. */
export function flushLifecycleJournal(): Promise<void> {
	if (flushing) return flushing
	let succeeded = false
	flushing = persist()
		.then((result) => {
			succeeded = result
		})
		.finally(() => {
			flushing = undefined
			// An event can arrive between persist resolving and this continuation.
			if (succeeded && pending.length) void flushLifecycleJournal()
		})
	return flushing
}

async function persist(): Promise<boolean> {
	let succeeded = true
	try {
		if (!loaded) {
			const saved = await chrome.storage.local.get(KEY)
			events = Array.isArray(saved[KEY])
				? saved[KEY].map(normalizeLifecycleEvent)
						.filter((item: LifecycleEvent | null): item is LifecycleEvent => item !== null)
						.slice(-MAX_EVENTS)
				: []
			loaded = true
		}
		while (pending.length) {
			const batch = pending
			pending = []
			events = [...events, ...batch].filter((item) => item.ts > Date.now() - 7 * 86400000).slice(-MAX_EVENTS)
			await chrome.storage.local.set({ [KEY]: events })
		}
	} catch {
		succeeded = false
		// Keep evidence in memory and retry on the next event. Never recursively log a storage error.
		pending = [...pending, { ts: Date.now(), session, operation: 'storage.failed', detail: { sequence: ++sequence } }].slice(-MAX_EVENTS)
	}
	if (!sink || flushTimer) return succeeded
	flushTimer = setTimeout(() => {
		flushTimer = undefined
		sink?.()
	}, 250)
	return succeeded
}

/** Return available stored and pending evidence, including storage failures. */
export const lifecycleSnapshot = (): LifecycleEvent[] => [...events, ...pending].slice(-MAX_EVENTS)

/** Mirror evidence to the live control host. The disposer cannot remove a newer session's sink. */
export function setLifecycleSink(callback: () => void): () => void {
	sink = callback
	return () => {
		if (sink === callback) sink = undefined
	}
}

/** Record an API failure without arbitrary page or credential text. */
export function recordLifecycleError(operation: string, error: unknown, detail: LifecycleEvent['detail'] = {}): void {
	recordLifecycle(operation, { ...detail, ...errorEvidence(error) })
}

/** Install synchronous global listeners before initializing worker services. */
export function startLifecycleJournal(): void {
	globalThis.addEventListener?.('error', (event) => recordLifecycleError('worker.uncaught', (event as ErrorEvent).error))
	globalThis.addEventListener?.('unhandledrejection', (event) =>
		recordLifecycleError('worker.unhandledrejection', (event as PromiseRejectionEvent).reason),
	)
	let extensionVersion: string | null = null
	let manifestError: unknown
	try {
		extensionVersion = chrome.runtime.getManifest().version
	} catch (error) {
		manifestError = error
	}
	recordLifecycle('worker.boot', { extensionVersion, protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION })
	if (manifestError) recordLifecycleError('api.getManifest.failed', manifestError)
}
