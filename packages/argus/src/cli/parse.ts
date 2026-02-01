/** Extract an error message from an unknown thrown value. */
export const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

/** Parse a string to a finite number, or return `undefined`. */
export const parseNumber = (value?: string): number | undefined => {
	if (!value) {
		return undefined
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return undefined
	}
	return parsed
}

/** Parse a string to a non-negative integer, or return `undefined`. */
export const parsePositiveInt = (value?: string, options?: { allowZero?: boolean }): number | undefined => {
	if (value === undefined) {
		return undefined
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		return undefined
	}
	const min = options?.allowZero ? 0 : 1
	if (parsed < min) {
		return undefined
	}
	return parsed
}

/** Trim a string query value; return `undefined` if empty/nullish. */
export const normalizeQueryValue = (value?: string): string | undefined => {
	if (value == null) {
		return undefined
	}
	const trimmed = value.trim()
	if (!trimmed) {
		return undefined
	}
	return trimmed
}
