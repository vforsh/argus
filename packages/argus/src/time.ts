export const parseDurationMs = (value: string): number | null => {
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

	const unit = match[2] ?? 's'
	const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000

	return amount * multiplier
}
