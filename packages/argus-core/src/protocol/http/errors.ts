/** Error detail carried by {@link ErrorResponse} and by inline `lastError` fields. */
export type ErrorDetail = {
	message: string
	code?: string
}

/** Standard error payload for API failures. */
export type ErrorResponse = {
	ok: false
	error: ErrorDetail
}

/**
 * A response payload with its `ok: true` discriminant removed.
 *
 * Consumers that already know a call succeeded (an SDK method that throws on failure,
 * for instance) return this instead of hand-retyping every field of the wire response —
 * so a new field on the protocol type reaches them for free.
 */
export type ResponseData<T extends { ok: true }> = Omit<T, 'ok'>
