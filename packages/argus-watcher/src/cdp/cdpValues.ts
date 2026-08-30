/**
 * Narrowing helpers for CDP event payloads.
 *
 * Every field on a `Network.*` payload is optional and untyped at runtime, so both capture modules
 * had grown identical private copies of these two. Keeping one pair means the two capture paths
 * cannot disagree about what "absent" looks like on the wire.
 */

/** A finite number, or `null` for anything else (absent, `NaN`, a string). */
export const pickNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** A non-empty trimmed string, or `null`. Chrome sends `''` for fields it has no value for. */
export const normalizeString = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null
	}
	const trimmed = value.trim()
	return trimmed || null
}
