/** The page exception shape carried by `EvalResponse.exception`. */
type EvalException = { text: string; details?: unknown }

/**
 * Thrown when an expression raises inside the page.
 *
 * Only value-returning eval APIs (`evalValue`, `evalUntil`) throw this. Raw
 * `client.eval` keeps reporting page exceptions in its `exception` field so callers
 * can inspect a failure without a try/catch.
 */
export class ArgusEvalError extends Error {
	/** Structured exception detail from the page, when the transport provided one. */
	readonly details?: unknown

	/**
	 * @param text Page-side exception text, used as the error message.
	 * @param details Optional structured exception detail from CDP.
	 */
	constructor(text: string, details?: unknown) {
		super(text)
		this.name = 'ArgusEvalError'
		this.details = details
	}

	/**
	 * Build an error from a watcher exception payload.
	 *
	 * CDP reports `text` as a bare `"Uncaught"` for thrown errors and puts the real
	 * message plus stack in `details.description`, so prefer that when present.
	 */
	static fromException(exception: EvalException): ArgusEvalError {
		return new ArgusEvalError(readExceptionDescription(exception.details) ?? exception.text, exception.details)
	}
}

const readExceptionDescription = (details: unknown): string | undefined => {
	if (details == null || typeof details !== 'object' || !('description' in details)) {
		return undefined
	}

	const { description } = details as { description?: unknown }
	return typeof description === 'string' && description.trim() ? description : undefined
}
