import type http from 'node:http'
import type { NetQuery } from '@vforsh/argus-core'
import { NET_PARTIES, NET_SCOPES } from '@vforsh/argus-core'
import type { NetFilterContext, NetFilters, NetParty, NetScope } from '../../net/filtering.js'
import { derivePartyHost, normalizeNetUrlKey } from '../../net/filtering.js'
import type { HttpRequestEventMetadata } from '../server.js'
import type { RouteContext } from './types.js'
import { clampNumber, normalizeQueryValue, optionalNumber, respondApiError } from '../httpUtils.js'

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
 * Read a network query param. The key is checked against {@link NetQuery}, so renaming a param in
 * the protocol breaks this parser at compile time instead of silently dropping the filter.
 */
const netParam = (searchParams: URLSearchParams, key: keyof NetQuery): string | null => searchParams.get(key)

/** Repeatable counterpart to {@link netParam}. */
const netParams = (searchParams: URLSearchParams, key: keyof NetQuery): string[] => searchParams.getAll(key)

/** Respond 400 `net_disabled`. Shared precondition failure for all `/net*` routes. */
export const respondNetDisabled = (res: http.ServerResponse): void => {
	respondApiError(res, 400, 'net_disabled', 'Network capture is disabled for this watcher')
}

/**
 * Cursor the client should send as `after` on its next poll.
 *
 * The last id in the page, or the cursor it already had when the page is empty — never a value the
 * client would have to interpret. Every `/net*` listing route paginates this way; keeping the
 * expression in one place is what stops one of them from quietly resetting a poller to 0.
 */
export const nextAfterCursor = (page: readonly { id: number }[], after: number): number => page[page.length - 1]?.id ?? after

/**
 * Parse network filters from a route URL with the standard after/limit/sinceTs
 * defaults shared by the `/net*` listing routes. Responds 400 `invalid_net_filter`
 * and returns null when the query is invalid.
 */
export const readNetFiltersFromUrl = (url: URL, ctx: RouteContext, res: http.ServerResponse): ParsedNetFilters | null => {
	const filters = parseNetRequestFilters(url.searchParams, {
		after: clampNumber(netParam(url.searchParams, 'after'), 0),
		limit: clampNumber(netParam(url.searchParams, 'limit'), 500, 1, 5000),
		sinceTs: optionalNumber(netParam(url.searchParams, 'sinceTs')),
		context: ctx.getNetFilterContext?.() ?? null,
	})
	if (filters.error || !filters.value) {
		respondApiError(res, 400, 'invalid_net_filter', filters.error ?? 'Invalid network filter')
		return null
	}
	return filters.value
}

/**
 * Parse and resolve network query params so every `/net*` route shares the same semantics.
 * Scope defaults are resolved against the active watcher target instead of forcing the CLI
 * to guess whether an iframe is currently selected.
 */
export const parseNetRequestFilters = (searchParams: URLSearchParams, options: ParseNetFilterOptions): ParseNetFilterResult => {
	const scope = normalizeScope(netParam(searchParams, 'scope'))
	if (scope.error) {
		return { error: scope.error }
	}

	const frame = normalizeFrame(netParam(searchParams, 'frame'))
	if (frame.error) {
		return { error: frame.error }
	}

	if (scope.value && frame.value) {
		return { error: 'Cannot combine scope and frame filters. Use one or the other.' }
	}

	const party = normalizeParty(netParam(searchParams, 'party'))
	if (party.error) {
		return { error: party.error }
	}

	const context = options.context ?? null
	const resolvedScope = scope.value ?? DEFAULT_NET_SCOPE
	const resolvedFrameId = resolveFrameId({ frame: frame.value ?? null, scope: resolvedScope, context })
	const partyHost = derivePartyHost(resolvePartyReferenceUrl(resolvedScope, context))

	return {
		value: {
			after: options.after,
			limit: options.limit,
			sinceTs: options.sinceTs,
			grep: normalizeQueryValue(netParam(searchParams, 'grep')),
			ignoreHosts: normalizeRepeatedValues(netParams(searchParams, 'ignoreHost')),
			ignorePatterns: normalizeRepeatedValues(netParams(searchParams, 'ignorePattern')),
			hosts: normalizeRepeatedValues(netParams(searchParams, 'host')),
			methods: normalizeRepeatedValues(netParams(searchParams, 'method')),
			statuses: normalizeStatusValues(netParams(searchParams, 'status')),
			resourceTypes: normalizeRepeatedValues(netParams(searchParams, 'resourceType')),
			mimeTypes: normalizeRepeatedValues(netParams(searchParams, 'mime')),
			party: party.value,
			partyHost,
			frameId: resolvedFrameId,
			documentUrlKey: resolveDocumentUrlKey({ frame: frame.value ?? null, scope: resolvedScope, context }),
			failedOnly: hasTruthyFlag(searchParams, 'failedOnly'),
			minDurationMs: optionalNumber(netParam(searchParams, 'minDurationMs'), 1),
			minTransferBytes: optionalNumber(netParam(searchParams, 'minTransferBytes'), 1),
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

/** Scope applied when a request does not specify one. */
const DEFAULT_NET_SCOPE: NetScope = 'tab'

const normalizeScope = (value: string | null): NormalizedValueResult<NetScope> => {
	return normalizeChoice(value, NET_SCOPES, 'scope filter')
}

const normalizeFrame = (value: string | null): NormalizedValueResult<string | null> => {
	const normalized = normalizeQueryValue(value)
	if (!normalized) {
		return {}
	}

	return { value: normalized }
}

const normalizeParty = (value: string | null): NormalizedValueResult<NetParty> => {
	return normalizeChoice(value, NET_PARTIES, 'party filter')
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

const hasTruthyFlag = (searchParams: URLSearchParams, key: keyof NetQuery): boolean => {
	const value = netParam(searchParams, key)
	if (value == null) {
		return false
	}

	const normalized = value.trim().toLowerCase()
	return normalized !== '' && normalized !== '0' && normalized !== 'false'
}
