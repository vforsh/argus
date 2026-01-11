export type PreviewStringifyOptions = {
	maxDepth?: number
	maxKeys?: number
	maxArrayLength?: number
	maxStringLength?: number
}

type PreviewState = {
	options: Required<PreviewStringifyOptions>
	seen: WeakSet<object>
}

const DEFAULT_OPTIONS: Required<PreviewStringifyOptions> = {
	maxDepth: 3,
	maxKeys: 50,
	maxArrayLength: 50,
	maxStringLength: 500,
}

const normalizeOptions = (options?: PreviewStringifyOptions): Required<PreviewStringifyOptions> => ({
	maxDepth: clampOption(options?.maxDepth, DEFAULT_OPTIONS.maxDepth),
	maxKeys: clampOption(options?.maxKeys, DEFAULT_OPTIONS.maxKeys),
	maxArrayLength: clampOption(options?.maxArrayLength, DEFAULT_OPTIONS.maxArrayLength),
	maxStringLength: clampOption(options?.maxStringLength, DEFAULT_OPTIONS.maxStringLength),
})

const clampOption = (value: number | undefined, fallback: number): number => {
	if (value == null || !Number.isFinite(value) || value < 0) {
		return fallback
	}
	return Math.floor(value)
}

const truncateString = (value: string, maxStringLength: number): string => {
	if (maxStringLength <= 0) {
		return ''
	}
	if (value.length <= maxStringLength) {
		return value
	}
	const headLength = Math.max(0, maxStringLength - 3)
	return `${value.slice(0, headLength)}...`
}

const formatFunction = (value: Function): string => {
	const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name : ''
	return name ? `[Function ${name}]` : '[Function]'
}

const formatSymbol = (value: symbol): string => {
	const desc = value.description
	return desc ? `[Symbol ${desc}]` : '[Symbol]'
}

const createTruncatedObjectMarker = (): Record<string, string> => ({ '...': '...' })

const createTruncatedArrayMarker = (): string[] => ['...']

const formatErrorPreview = (value: Error, state: PreviewState): Record<string, string> => {
	const { maxStringLength } = state.options
	const name = typeof value.name === 'string' ? truncateString(value.name, maxStringLength) : 'Error'
	const message = typeof value.message === 'string' ? truncateString(value.message, maxStringLength) : ''
	const out: Record<string, string> = { name, message }
	if (typeof value.stack === 'string' && value.stack.trim() !== '') {
		out.stack = truncateString(value.stack, maxStringLength)
	}
	return out
}

const toPreviewValue = (value: unknown, depth: number, state: PreviewState): unknown => {
	if (value === null) {
		return null
	}

	if (typeof value === 'string') {
		return truncateString(value, state.options.maxStringLength)
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return value
	}
	if (typeof value === 'bigint') {
		return `${value}n`
	}
	if (typeof value === 'undefined') {
		return undefined
	}
	if (typeof value === 'function') {
		return formatFunction(value)
	}
	if (typeof value === 'symbol') {
		return formatSymbol(value)
	}

	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			return 'Invalid Date'
		}
		return value.toISOString()
	}

	if (value instanceof Error) {
		return formatErrorPreview(value, state)
	}

	if (typeof value !== 'object') {
		return String(value)
	}

	if (state.seen.has(value)) {
		return '[Circular]'
	}

	if (Array.isArray(value)) {
		if (depth >= state.options.maxDepth) {
			return createTruncatedArrayMarker()
		}
		state.seen.add(value)
		const output: unknown[] = []
		const limit = Math.min(value.length, state.options.maxArrayLength)
		for (let i = 0; i < limit; i += 1) {
			output.push(toPreviewValue(value[i], depth + 1, state))
		}
		if (value.length > limit) {
			output.push('...')
		}
		return output
	}

	if (depth >= state.options.maxDepth) {
		return createTruncatedObjectMarker()
	}

	state.seen.add(value)
	const record = value as Record<string, unknown>
	const keys = Object.keys(record)
	const limit = Math.min(keys.length, state.options.maxKeys)
	const output: Record<string, unknown> = {}
	for (let i = 0; i < limit; i += 1) {
		const key = keys[i]
		try {
			output[key] = toPreviewValue(record[key], depth + 1, state)
		} catch {
			output[key] = '[Thrown]'
		}
	}
	if (keys.length > limit) {
		output['...'] = '...'
	}
	return output
}

/** Create a bounded preview value suitable for JSON output and logging. */
export const previewValue = (value: unknown, options?: PreviewStringifyOptions): unknown => {
	const state: PreviewState = {
		options: normalizeOptions(options),
		seen: new WeakSet<object>(),
	}
	return toPreviewValue(value, 0, state)
}

/** Stringify a value with bounded preview rules for human-readable logs. */
export const previewStringify = (value: unknown, options?: PreviewStringifyOptions): string => {
	const state: PreviewState = {
		options: normalizeOptions(options),
		seen: new WeakSet<object>(),
	}

	if (typeof value === 'string') {
		return truncateString(value, state.options.maxStringLength)
	}
	if (typeof value === 'undefined') {
		return 'undefined'
	}

	const preview = toPreviewValue(value, 0, state)
	if (typeof preview === 'string') {
		return preview
	}
	if (typeof preview === 'undefined') {
		return 'undefined'
	}
	try {
		const result = JSON.stringify(preview)
		return result ?? 'undefined'
	} catch {
		return String(preview)
	}
}
