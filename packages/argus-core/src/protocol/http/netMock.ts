/**
 * Network request mocking protocol (`/net/mock*` endpoints).
 *
 * Rules intercept live requests via the CDP `Fetch` domain. Each rule pairs a
 * match (URL pattern + optional method/resource-type) with an action:
 * block, fail with a network error, fulfill with a stubbed response, or
 * continue with rewrites. Rules persist in the watcher until removed and are
 * re-armed when the watcher reattaches.
 */

/**
 * Match criteria for a mock rule.
 *
 * `url` is matched against the full request URL, case-insensitively.
 * `*` matches any run of characters; a pattern without `*` is treated as a
 * substring match (equivalent to `*pattern*`).
 */
import { defineProtocolSchema, invalidProtocolPayload, isProtocolObject, validProtocolPayload } from '../schema.js'
import {
	compact,
	fieldError,
	isFieldError,
	optionalArray,
	optionalEnum,
	optionalInteger,
	optionalNonEmptyString,
	optionalNumber,
	optionalString,
	readFields,
	requireObject,
	requiredString,
	type FieldError,
} from '../schemaFields.js'
import type { ErrorDetail, Ok } from './errors.js'

export type NetMockMatch = {
	/** URL wildcard pattern (substring match when it contains no `*`). */
	url: string
	/** Optional HTTP method filter (case-insensitive, e.g. "POST"). */
	method?: string
	/** Optional CDP resource type filter (case-insensitive, e.g. "Fetch", "XHR", "Document"). */
	resourceType?: string
}

/** CDP target scope where a mock rule intercepts requests. Defaults to the top-level page. */
export type NetMockScope = 'page' | 'selected'

/** One HTTP header entry used in fulfill/continue actions. */
export type NetMockHeader = {
	name: string
	value: string
}

/** CDP network error reasons accepted by `fail` actions. */
export const NET_MOCK_FAIL_REASONS = [
	'Failed',
	'Aborted',
	'TimedOut',
	'AccessDenied',
	'ConnectionClosed',
	'ConnectionReset',
	'ConnectionRefused',
	'ConnectionAborted',
	'ConnectionFailed',
	'NameNotResolved',
	'InternetDisconnected',
	'AddressUnreachable',
	'BlockedByClient',
	'BlockedByResponse',
] as const

/** Network error reason for `fail` actions. */
export type NetMockFailReason = (typeof NET_MOCK_FAIL_REASONS)[number]

/**
 * Action applied when a rule matches.
 *
 * - `block` aborts the request as `BlockedByClient`.
 * - `fail` aborts with the given network error reason, so page `fetch()` calls reject.
 * - `fulfill` answers with a synthetic response; the request never reaches the network.
 * - `continue` forwards the request, optionally overriding headers or the URL host/origin.
 */
export type NetMockAction =
	| { kind: 'block' }
	| { kind: 'fail'; reason: NetMockFailReason }
	| { kind: 'fulfill'; status: number; headers?: NetMockHeader[]; bodyBase64?: string }
	| { kind: 'continue'; setHeaders?: NetMockHeader[]; rewriteHost?: string }

/** One installed mock rule, including hit accounting. */
export type NetMockRule = {
	/** Watcher-local rule id, unique for the watcher lifetime. */
	id: number
	/** Target scope for this rule. Omitted by older watchers and treated as `page`. */
	scope?: NetMockScope
	match: NetMockMatch
	action: NetMockAction
	/** Delay before the action executes, in milliseconds. */
	delayMs?: number
	/** Maximum number of applications; the rule stops matching after `hits` reaches this. Undefined = unlimited. */
	times?: number
	/** How many requests this rule has been applied to. */
	hits: number
	/** Epoch ms when the rule was added. */
	createdAt: number
}

/** POST /net/mock/add request payload. */
export type NetMockAddRequest = {
	/** Target scope for this rule. Defaults to `page`. */
	scope?: NetMockScope
	match: NetMockMatch
	action: NetMockAction
	/** Delay before the action executes, in milliseconds. Must be a finite number >= 0. */
	delayMs?: number
	/** Maximum number of applications. Must be an integer >= 1. */
	times?: number
}

/** POST /net/mock/add response. */
export type NetMockAddResponse = Ok<{
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether Fetch interception is active on the attached target. False when detached (rule is queued). */
	enabled: boolean
	/** The installed rule. */
	rule: NetMockRule
	/** Optional error details when interception could not be enabled. */
	error?: ErrorDetail | null
}>

/** POST /net/mock/remove request payload. */
export type NetMockRemoveRequest = {
	/** Rule id to remove. */
	id: number
}

/** POST /net/mock/remove response. */
export type NetMockRemoveResponse = Ok<{
	/** True when a rule with the given id existed and was removed. */
	removed: boolean
	/** Whether Fetch interception remains active after the removal. */
	enabled: boolean
}>

/** POST /net/mock/clear response. */
export type NetMockClearResponse = Ok<{
	/** Number of rules removed. */
	removed: number
	/** Whether Fetch interception remains active (always false after clear unless disable failed). */
	enabled: boolean
}>

/** GET /net/mock response. */
export type NetMockStatusResponse = Ok<{
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether Fetch interception is active on the attached target. */
	enabled: boolean
	/** Installed rules in match order (first match wins). */
	rules: NetMockRule[]
	/** Last interception error (enable/disable or action failure), if any. */
	lastError?: ErrorDetail | null
}>

// ─────────────────────────────────────────────────────────────────────────────
// Request schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Scopes accepted by POST /net/mock/add. */
export const NET_MOCK_SCOPES = ['page', 'selected'] as const

/** Read an optional list of `{ name, value }` header entries. */
const optionalHeaders = (source: Record<string, unknown>, key: string): NetMockHeader[] | undefined | FieldError => {
	const headers = optionalArray(source, key)
	if (headers == null || isFieldError(headers)) {
		return headers === undefined ? undefined : fieldError(`${key} must be an array of { name, value } entries`)
	}

	const parsed: NetMockHeader[] = []
	for (const header of headers) {
		if (!isProtocolObject(header) || typeof header.name !== 'string' || header.name.trim() === '' || typeof header.value !== 'string') {
			return fieldError(`${key} entries must have a non-empty string name and a string value`)
		}
		parsed.push({ name: header.name, value: header.value })
	}
	return parsed
}

/** Validate the `match` half of an add request. */
const parseNetMockMatch = (value: unknown): NetMockMatch | FieldError => {
	if (!isProtocolObject(value)) {
		return fieldError('match must be an object')
	}

	const fields = readFields(value, {
		url: requiredString,
		method: optionalNonEmptyString,
		resourceType: optionalNonEmptyString,
	})
	if (!fields.ok) {
		return fieldError(`match.${fields.issues[0]?.message ?? 'url must be a non-empty string'}`)
	}

	return compact(fields.value)
}

/**
 * Validate the `action` half of an add request.
 *
 * `delayMs` participates because a bare `continue` with no header rewrite, host rewrite,
 * or delay would install a rule that does nothing.
 */
const parseNetMockAction = (value: unknown, delayMs: number | undefined): NetMockAction | FieldError => {
	if (!isProtocolObject(value) || typeof value.kind !== 'string') {
		return fieldError('action.kind must be one of: block, fail, fulfill, continue')
	}

	if (value.kind === 'block') {
		return { kind: 'block' }
	}

	if (value.kind === 'fail') {
		const reason = optionalEnum(value, 'reason', NET_MOCK_FAIL_REASONS)
		if (isFieldError(reason) || reason == null) {
			return fieldError(`action.reason must be one of: ${NET_MOCK_FAIL_REASONS.join(', ')}`)
		}
		return { kind: 'fail', reason }
	}

	if (value.kind === 'fulfill') {
		const status = optionalInteger(value, 'status', { min: 100, max: 599 })
		if (isFieldError(status) || status == null) {
			return fieldError('action.status must be an integer between 100 and 599')
		}
		const headers = optionalHeaders(value, 'headers')
		if (isFieldError(headers)) return fieldError(headers.__fieldError.replace(/^headers/, 'action.headers'))
		const bodyBase64 = optionalString(value, 'bodyBase64')
		if (isFieldError(bodyBase64)) return fieldError('action.bodyBase64 must be a string')

		return compact({ kind: 'fulfill' as const, status, headers, bodyBase64 })
	}

	if (value.kind === 'continue') {
		const setHeaders = optionalHeaders(value, 'setHeaders')
		if (isFieldError(setHeaders)) return fieldError(setHeaders.__fieldError.replace(/^setHeaders/, 'action.setHeaders'))
		const rewriteHost = optionalNonEmptyString(value, 'rewriteHost')
		if (isFieldError(rewriteHost)) return fieldError('action.rewriteHost must be a non-empty string')
		if (value.rewriteHost !== undefined && rewriteHost == null) {
			return fieldError('action.rewriteHost must be a non-empty string')
		}

		if (!setHeaders?.length && rewriteHost == null && delayMs === undefined) {
			return fieldError('continue action requires at least one of: setHeaders, rewriteHost, delayMs')
		}

		return compact({ kind: 'continue' as const, setHeaders, rewriteHost })
	}

	return fieldError('action.kind must be one of: block, fail, fulfill, continue')
}

/** Schema for POST /net/mock/add request payloads. */
export const netMockAddRequestSchema = defineProtocolSchema<NetMockAddRequest>((value) => {
	const invalid = requireObject<NetMockAddRequest>(value)
	if (invalid) return invalid
	const source = value as Record<string, unknown>

	const fields = readFields(source, {
		delayMs: (input, key) => optionalNumber(input, key, { min: 0 }),
		times: (input, key) => optionalInteger(input, key, { min: 1 }),
		scope: (input, key) => optionalEnum(input, key, NET_MOCK_SCOPES),
	})
	if (!fields.ok) return fields

	const match = parseNetMockMatch(source.match)
	if (isFieldError(match)) return invalidProtocolPayload(match.__fieldError)

	const action = parseNetMockAction(source.action, fields.value.delayMs)
	if (isFieldError(action)) return invalidProtocolPayload(action.__fieldError)

	return validProtocolPayload(compact({ ...fields.value, match, action }))
})

/** Schema for POST /net/mock/remove request payloads. */
export const netMockRemoveRequestSchema = defineProtocolSchema<NetMockRemoveRequest>((value) => {
	const invalid = requireObject<NetMockRemoveRequest>(value)
	if (invalid) return invalid

	const id = optionalInteger(value as Record<string, unknown>, 'id', { min: 1 })
	if (isFieldError(id) || id == null) {
		return invalidProtocolPayload('id must be an integer >= 1')
	}

	return validProtocolPayload({ id })
})
