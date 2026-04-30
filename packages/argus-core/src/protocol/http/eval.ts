/** Request payload for POST /eval. */
export type EvalRequest = {
	expression: string
	/**
	 * String-only values exposed to evaluated code as `args`.
	 * Watchers install them for the duration of the eval without rewriting source.
	 */
	args?: Record<string, string>
	awaitPromise?: boolean
	/**
	 * Enable Chrome's REPL evaluation mode.
	 * This allows native top-level `await` and console-like repeated declarations.
	 */
	replMode?: boolean
	timeoutMs?: number
	returnByValue?: boolean
}

/** Response payload for POST /eval. */
export type EvalResponse = {
	ok: true
	result: unknown
	type: string | null
	exception: { text: string; details?: unknown } | null
}
