/** Pure lease record used to test the same owner/TTL invariants as the page-scoped lease. */
export type LeaseRecord = { token: string; operation: string; acquiredAt: number; expiresAt: number }

/** Acquire a lease atomically or return an actionable busy error. */
export const acquireLeaseRecord = (
	current: LeaseRecord | null,
	input: { token: string; operation: string; now: number; ttlMs: number },
): LeaseRecord | Error => {
	if (current && current.expiresAt > input.now && current.token !== input.token) {
		return new Error(`busy with "${current.operation}" (${current.expiresAt - input.now}ms lease remaining)`)
	}
	return { token: input.token, operation: input.operation, acquiredAt: input.now, expiresAt: input.now + input.ttlMs }
}

/** Renew only a live matching-token lease. */
export const renewLeaseRecord = (current: LeaseRecord | null, token: string, now: number, ttlMs: number): LeaseRecord | Error => {
	if (!current || current.token !== token) return new Error('lease was lost')
	if (current.expiresAt <= now) return new Error('lease expired')
	return { ...current, expiresAt: now + ttlMs }
}

/** Release only a matching-token lease. */
export const releaseLeaseRecord = (current: LeaseRecord | null, token: string): null | Error => {
	if (!current) return null
	return current.token === token ? null : new Error('lease belongs to another operation')
}
