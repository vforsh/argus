import type { NetFilterContext, NetFilters, NetParty, NetScope } from '../../net/filtering.js'
import { derivePartyHost, normalizeNetUrlKey } from '../../net/filtering.js'
import type { HttpRequestEventMetadata } from '../server.js'
import { clampNumber, normalizeQueryValue } from '../httpUtils.js'

export type ParsedNetFilters = NetFilters & {
	after: number
	limit: number
	scope: NetScope
	frame: string | null
}

type ParseNetFilterOptions = {
	after: number
	limit: number
	sinceTs?: number
	context?: NetFilterContext | null
}

type ParseNetFilterResult = {
	value?: ParsedNetFilters
	error?: string
}

type NormalizedValueResult<T> = {
	value?: T
	error?: string
}

/**
 * Parse and resolve network query params so every `/net*` route shares the same semantics.
 * Scope defaults are resolved against the active watcher target instead of forcing the CLI
 * to guess whether an iframe is currently selected.
 */
export const parseNetRequestFilters = (searchParams: URLSearchParams, options: ParseNetFilterOptions): ParseNetFilterResult => {
	const scope = normalizeScope(searchParams.get('scope'))
	if (scope.error) {
		return { error: scope.error }
	}

	const frame = normalizeFrame(searchParams.get('frame'))
	if (frame.error) {
		return { error: frame.error }
	}

	if (scope.value && frame.value) {
		return { error: 'Cannot combine scope and frame filters. Use one or the other.' }
	}

	const party = normalizeParty(searchParams.get('party'))
	if (party.error) {
		return { error: party.error }
	}

	const context = options.context ?? null
	const resolvedScope = scope.value ?? defaultScope(context)
	const resolvedFrameId = resolveFrameId({ frame: frame.value ?? null, scope: resolvedScope, context })
	const partyHost = derivePartyHost(resolvePartyReferenceUrl(resolvedScope, context))

	return {
		value: {
			after: options.after,
			limit: options.limit,
			sinceTs: options.sinceTs,
			grep: normalizeQueryValue(searchParams.get('grep')),
			ignoreHosts: normalizeRepeatedValues(searchParams.getAll('ignoreHost')),
			ignorePatterns: normalizeRepeatedValues(searchParams.getAll('ignorePattern')),
			hosts: normalizeRepeatedValues(searchParams.getAll('host')),
			methods: normalizeRepeatedValues(searchParams.getAll('method')),
			statuses: normalizeStatusValues(searchParams.getAll('status')),
			resourceTypes: normalizeRepeatedValues(searchParams.getAll('resourceType')),
			mimeTypes: normalizeRepeatedValues(searchParams.getAll('mime')),
			party: party.value,
			partyHost,
			frameId: resolvedFrameId,
			documentUrlKey: resolveDocumentUrlKey({ frame: frame.value ?? null, scope: resolvedScope, context }),
			failedOnly: hasTruthyFlag(searchParams, 'failedOnly'),
			minDurationMs: clampNumber(searchParams.get('minDurationMs'), undefined, 1),
			minTransferBytes: clampNumber(searchParams.get('minTransferBytes'), undefined, 1),
			scope: resolvedScope,
			frame: frame.value ?? null,
		},
	}
}

export const toNetRequestEventQuery = (filters: ParsedNetFilters, options: { timeoutMs?: number } = {}): HttpRequestEventMetadata['query'] => ({
	after: filters.after,
	limit: filters.limit,
	sinceTs: filters.sinceTs,
	timeoutMs: options.timeoutMs,
	grep: filters.grep,
	hosts: filters.hosts,
	methods: filters.methods,
	statuses: filters.statuses,
	resourceTypes: filters.resourceTypes,
	mimeTypes: filters.mimeTypes,
	scope: filters.scope,
	frame: filters.frame ?? undefined,
	party: filters.party,
	failedOnly: filters.failedOnly,
	minDurationMs: filters.minDurationMs,
	minTransferBytes: filters.minTransferBytes,
	ignoreHosts: filters.ignoreHosts,
	ignorePatterns: filters.ignorePatterns,
})

const resolveDocumentUrlKey = (options: { frame: string | null; scope: NetScope; context: NetFilterContext | null }): string | null => {
	if (options.frame && options.frame !== 'selected' && options.frame !== 'page') {
		return null
	}

	if (options.frame == null && options.scope === 'tab') {
		return null
	}

	const baseUrl =
		options.frame === 'page'
			? (options.context?.pageUrl ?? null)
			: options.frame === 'selected'
				? (options.context?.selectedTargetUrl ?? options.context?.pageUrl ?? null)
				: resolvePartyReferenceUrl(options.scope, options.context)

	return normalizeNetUrlKey(baseUrl)
}

const defaultScope = (_context: NetFilterContext | null): NetScope => 'tab'

const resolveFrameId = (options: { frame: string | null; scope: NetScope; context: NetFilterContext | null }): string | undefined => {
	if (options.frame === 'selected') {
		return options.context?.selectedFrameId ?? options.context?.topFrameId ?? undefined
	}

	if (options.frame === 'page') {
		return options.context?.topFrameId ?? undefined
	}

	if (options.frame) {
		return options.frame
	}

	if (options.scope === 'tab') {
		return undefined
	}

	if (options.scope === 'page') {
		return options.context?.topFrameId ?? undefined
	}

	return options.context?.selectedFrameId ?? options.context?.topFrameId ?? undefined
}

const resolvePartyReferenceUrl = (scope: NetScope, context: NetFilterContext | null): string | null => {
	if (!context) {
		return null
	}

	if (scope === 'selected') {
		return context.selectedTargetUrl ?? context.pageUrl
	}

	return context.pageUrl ?? context.selectedTargetUrl
}

const normalizeScope = (value: string | null): NormalizedValueResult<NetScope> => {
	return normalizeChoice(value, ['selected', 'page', 'tab'], 'scope filter')
}

const normalizeFrame = (value: string | null): NormalizedValueResult<string | null> => {
	const normalized = normalizeQueryValue(value)
	if (!normalized) {
		return {}
	}

	if (normalized === 'selected' || normalized === 'page') {
		return { value: normalized }
	}

	return { value: normalized }
}

const normalizeParty = (value: string | null): NormalizedValueResult<NetParty> => {
	return normalizeChoice(value, ['first', 'third'], 'party filter')
}

const normalizeChoice = <T extends string>(value: string | null, allowed: readonly T[], label: string): NormalizedValueResult<T> => {
	const normalized = normalizeQueryValue(value)
	if (!normalized) {
		return {}
	}

	if (allowed.includes(normalized as T)) {
		return { value: normalized as T }
	}

	return { error: `Invalid ${label}: ${value}` }
}

const normalizeRepeatedValues = (values: string[]): string[] | undefined => {
	const normalized = values.map((value) => normalizeQueryValue(value)).filter((value): value is string => value != null)
	return normalized.length > 0 ? normalized : undefined
}

const normalizeStatusValues = (values: string[]): string[] | undefined => {
	const normalized = normalizeRepeatedValues(values)?.map((value) => value.toLowerCase())
	if (!normalized?.length) {
		return undefined
	}

	return normalized
}

const hasTruthyFlag = (searchParams: URLSearchParams, key: string): boolean => {
	const value = searchParams.get(key)
	if (value == null) {
		return false
	}

	const normalized = value.trim().toLowerCase()
	return normalized !== '' && normalized !== '0' && normalized !== 'false'
}
