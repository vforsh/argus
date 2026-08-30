/**
 * The cross-layer coded-error contract.
 *
 * Failures travel from CDP and source layers up to the HTTP routes as an `Error` carrying
 * a string `code`, which routes map onto the wire envelope. That contract had no owning
 * type or constructor, so producers mutated-and-cast at six-plus sites and consumers
 * re-derived the sniff at eight more, in four different idioms. The duplicated
 * `createNotAttachedError` in two source modules was the tell: the concept existed, the
 * abstraction did not.
 */

/** An `Error` carrying a machine-readable code. */
export type CodedError = Error & { code: string }

/** Build an error the HTTP layer can map onto an error code. */
export const codedError = (code: string, message: string): CodedError => Object.assign(new Error(message), { code })

/** Read the code off an error, or `undefined` when it carries none. */
export const getErrorCode = (error: unknown): string | undefined => {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return undefined
	}

	const code = (error as { code?: unknown }).code
	return typeof code === 'string' ? code : undefined
}

/** True when an error carries this exact code. */
export const hasErrorCode = (error: unknown, code: string): boolean => getErrorCode(error) === code

/** The watcher is not attached to a CDP target. Raised by both transports. */
export const createNotAttachedError = (message = 'No tab attached via extension'): CodedError => codedError('cdp_not_attached', message)
