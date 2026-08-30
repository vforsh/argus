/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * `catch` binds `unknown`, so every call site otherwise writes the same
 * `error instanceof Error ? error.message : String(error)` ternary. Falsy throws (`throw null`,
 * a rejected promise with no reason) become `'unknown error'` rather than the literal `'null'`.
 */
export const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
