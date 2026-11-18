import type { WatcherRecord } from '@vforsh/argus-core'

/**
 * Parse repeatable `--label key=value` flags. The value may contain `=`; the key may not be empty.
 * A null-prototype map, so `__proto__=x` is an ordinary label rather than a silently dropped one
 * (which would turn a `--label` filter into match-all).
 * @returns The labels, or an error message naming the malformed or conflicting flag.
 */
export const parseLabels = (values: readonly string[] | undefined): { ok: true; labels: Record<string, string> } | { ok: false; error: string } => {
	const labels: Record<string, string> = Object.create(null)
	for (const value of values ?? []) {
		const separator = value.indexOf('=')
		const key = separator > 0 ? value.slice(0, separator).trim() : ''
		if (!key) return { ok: false, error: `Invalid --label ${JSON.stringify(value)}: expected key=value.` }
		const labelValue = value.slice(separator + 1)
		if (Object.hasOwn(labels, key) && labels[key] !== labelValue) {
			return { ok: false, error: `Conflicting --label values for ${JSON.stringify(key)}.` }
		}
		labels[key] = labelValue
	}
	return { ok: true, labels }
}

/** True when the watcher carries every given label with the same value. */
export const matchesLabels = (watcher: Pick<WatcherRecord, 'labels'>, filter: Record<string, string>): boolean =>
	Object.entries(filter).every(([key, value]) => watcher.labels != null && Object.hasOwn(watcher.labels, key) && watcher.labels[key] === value)

/** `session=abc,task=x`, or an empty string. */
export const formatLabels = (labels: Record<string, string> | undefined): string =>
	Object.entries(labels ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join(',')
