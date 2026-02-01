/** Request payload for POST /eval. */
export type EvalRequest = {
	expression: string
	awaitPromise?: boolean
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
