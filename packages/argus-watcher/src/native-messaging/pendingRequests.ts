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
}

export type PendingRequestTable<T> = {
	/** Register `requestId` and resolve once it settles, or reject when its deadline passes. */
	open: (requestId: number, options?: { timeoutMs?: number; timeoutMessage?: string }) => Promise<T>
	/** Settle with a value. An unknown or already-timed-out id is ignored. */
	settle: (requestId: number, value: T) => void
	/** Settle with a failure. An unknown or already-timed-out id is ignored. */
	fail: (requestId: number, error: Error) => void
}

/**
 * Build a table of in-flight requests.
 *
 * @param defaults Deadline and message used when `open` is called without its own.
 */
export const createPendingRequestTable = <T>(defaults: { timeoutMs: number; timeoutMessage: string }): PendingRequestTable<T> => {
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
				const timeout = setTimeout(() => {
					requests.delete(requestId)
					reject(new Error(options?.timeoutMessage ?? defaults.timeoutMessage))
				}, timeoutMs)
				requests.set(requestId, { resolve, reject, timeout })
			}),
		settle: (requestId, value) => {
			take(requestId)?.resolve(value)
		},
		fail: (requestId, error) => {
			take(requestId)?.reject(error)
		},
	}
}

/** Per-instance request id source. Ids only have to be unique within one native-messaging channel. */
export const createRequestIdAllocator = (): (() => number) => {
	let nextRequestId = 1
	return () => nextRequestId++
}
