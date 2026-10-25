import { delay } from '@vforsh/argus-core'

export type PollOptions = {
	timeoutMs?: number
	intervalMs?: number
	/** Treat a throwing `read` as "not yet" (e.g. evals racing a navigation) instead of failing at once. */
	ignoreErrors?: boolean
}

/**
 * Read until `done(value)` holds. Always reads at least once; on timeout throws with the last value
 * (and last error, when ignored) so a failure says what the state actually was.
 */
export const waitFor = async <T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	{ timeoutMs = 10_000, intervalMs = 100, ignoreErrors = false }: PollOptions = {},
): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	let last: { value: T } | undefined
	let lastError: unknown
	do {
		try {
			const value = await read()
			last = { value }
			if (done(value)) return value
		} catch (error) {
			if (!ignoreErrors) throw error
			lastError = error
		}
		await delay(intervalMs)
	} while (Date.now() < deadline)
	const errorText = lastError === undefined ? '' : `\nlast error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
	throw new Error(`Timed out after ${timeoutMs}ms; last value: ${last ? JSON.stringify(last.value) : 'none'}${errorText}`)
}
