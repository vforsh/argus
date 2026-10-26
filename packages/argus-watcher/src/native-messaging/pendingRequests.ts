import { recordNative } from './lifecycle.js'
/**
 * Correlating a native-messaging request with its response.
 *
 * Both session managers had grown their own copy of this: an id counter, a map of
 * resolve/reject/timeout triples, an `open` that arms a deadline, and a `settle` that clears it.
 * The tab manager's counter had also drifted to module scope while its map stayed per-instance, so
 * two managers in one process shared an id space they did not share a table with.
 */

type PendingRequest<T> = {
	resolve: (value: T) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
	journal: boolean
}

export type PendingRequestOptions = {
	timeoutMs?: number
	timeoutMessage?: string
	/** What was asked, e.g. `cdp_command Runtime.evaluate`; named in the timeout error. Protocol names only, never payloads. */
	label?: string
	/**
	 * Journal `request.open` / `request.settled`. Off for high-volume CDP traffic: journaling every
	 * command rotated the bounded incident files within minutes, so the evidence for an actual
	 * timeout was gone before anyone looked. Timeouts are always journaled.
	 */
	journal?: boolean
}

export type PendingRequestTable<T> = {
	/** Register `requestId` and resolve once it settles, or reject when its deadline passes. */
	open: (requestId: number, options?: PendingRequestOptions) => Promise<T>
	/** Settle with a value. An unknown or already-timed-out id is ignored. */
	settle: (requestId: number, value: T) => void
	/** Settle with a failure. An unknown or already-timed-out id is ignored. */
	fail: (requestId: number, error: Error) => void
}

/** Where a timed-out request stalled, judged by whether the extension kept talking after it was sent. */
export type BridgeStallPhase = 'extension_silent' | 'extension_active' | 'unknown'

/**
 * Build a table of in-flight requests.
 *
 * @param defaults Deadline and message used when `open` is called without its own; `lastInboundAt`
 *   reports when the extension last sent anything on this channel (epoch ms), so a timeout can say
 *   whether the whole channel went quiet or only this request went unanswered.
 */
export const createPendingRequestTable = <T>(defaults: {
	timeoutMs: number
	timeoutMessage: string
	lastInboundAt?: () => number | null
}): PendingRequestTable<T> => {
	const requests = new Map<number, PendingRequest<T>>()

	const take = (requestId: number): PendingRequest<T> | null => {
		const pending = requests.get(requestId)
		if (!pending) {
			return null
		}
		requests.delete(requestId)
		clearTimeout(pending.timeout)
		return pending
	}

	return {
		open: (requestId, options) =>
			new Promise<T>((resolve, reject) => {
				const timeoutMs = options?.timeoutMs ?? defaults.timeoutMs
				const journal = options?.journal !== false
				const startedAt = Date.now()
				const startedAtMono = performance.now()
				if (journal) recordNative('request.open', { requestId, deadline: startedAt + timeoutMs, timeoutMs })
				const timeout = setTimeout(() => {
					requests.delete(requestId)
					const elapsedMs = Math.round(performance.now() - startedAtMono)
					const stall = describeStall(startedAt, defaults.lastInboundAt?.() ?? null)
					recordNative('request.timeout', {
						requestId,
						elapsedMs,
						timeoutMs,
						phase: stall.phase,
						...(options?.label ? { type: options.label.split(' ')[0] } : {}),
					})
					const subject = options?.label ? `${options.label}, native request ${requestId}` : `native request ${requestId}`
					reject(
						new Error(
							`${options?.timeoutMessage ?? defaults.timeoutMessage} (${subject}; deadline ${startedAt + timeoutMs}; elapsed ${elapsedMs}ms; response not received; phase: ${stall.text})`,
						),
					)
				}, timeoutMs)
				requests.set(requestId, { resolve, reject, timeout, journal })
			}),
		settle: (requestId, value) => {
			const pending = take(requestId)
			if (!pending) return
			if (pending.journal) recordNative('request.settled', { requestId })
			pending.resolve(value)
		},
		fail: (requestId, error) => {
			take(requestId)?.reject(error)
		},
	}
}

/**
 * Classify a stall from channel liveness. "Silent" means the extension sent nothing at all after the
 * request went out — its service worker or the native channel is stuck, and no deadline helps.
 * "Active" means it kept answering other traffic but not this request — Chrome is still executing
 * the command (typically a long-running eval) or dropped it.
 */
const describeStall = (sentAt: number, lastInboundAt: number | null): { phase: BridgeStallPhase; text: string } => {
	if (lastInboundAt == null) return { phase: 'unknown', text: 'sent to extension; no reply' }
	if (lastInboundAt < sentAt) return { phase: 'extension_silent', text: 'sent to extension; extension silent since (worker or native channel stalled)' }
	const ago = Math.max(0, Date.now() - lastInboundAt)
	return { phase: 'extension_active', text: `sent to extension; extension still active (last message ${ago}ms ago) but this request is unanswered` }
}

/** Per-instance request id source. Ids only have to be unique within one native-messaging channel. */
export const createRequestIdAllocator = (): (() => number) => {
	let nextRequestId = 1
	return () => nextRequestId++
}
