/**
 * Resolve after `ms` milliseconds.
 *
 * Seventeen modules had defined this same one-liner privately, under two names.
 */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Duration suffixes accepted by {@link parseDurationMs}. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'

const UNIT_MS: Record<DurationUnit, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
}

/**
 * Parse a duration string such as `250ms`, `30s`, `10m`, `2h`, or `7d` into milliseconds.
 *
 * @param value Duration string. A bare number is interpreted using `defaultUnit`.
 * @param defaultUnit Unit applied when `value` carries no suffix. Defaults to seconds,
 *   matching the CLI's `--since`/`--duration` style flags; pass `'ms'` for flags whose
 *   documented examples are millisecond-scale.
 * @returns Milliseconds, or `null` when the value is empty or not a valid duration.
 *   Note that `0` is a valid result — check for `null` explicitly, not falsiness.
 */
export const parseDurationMs = (value: string, defaultUnit: DurationUnit = 's'): number | null => {
	const trimmed = value.trim()
	if (!trimmed) {
		return null
	}

	const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)?$/)
	if (!match) {
		return null
	}

	const amount = Number(match[1])
	if (!Number.isFinite(amount)) {
		return null
	}

	return amount * UNIT_MS[(match[2] as DurationUnit | undefined) ?? defaultUnit]
}
