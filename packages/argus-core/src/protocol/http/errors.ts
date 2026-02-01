/** Standard error payload for API failures. */
export type ErrorResponse = {
	ok: false
	error: {
		message: string
		code?: string
	}
}
