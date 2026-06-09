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
export type NetMockMatch = {
	/** URL wildcard pattern (substring match when it contains no `*`). */
	url: string
	/** Optional HTTP method filter (case-insensitive, e.g. "POST"). */
	method?: string
	/** Optional CDP resource type filter (case-insensitive, e.g. "Fetch", "XHR", "Document"). */
	resourceType?: string
}

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
	match: NetMockMatch
	action: NetMockAction
	/** Delay before the action executes, in milliseconds. Must be a finite number >= 0. */
	delayMs?: number
	/** Maximum number of applications. Must be an integer >= 1. */
	times?: number
}

/** POST /net/mock/add response. */
export type NetMockAddResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether Fetch interception is active on the attached target. False when detached (rule is queued). */
	enabled: boolean
	/** The installed rule. */
	rule: NetMockRule
	/** Optional error details when interception could not be enabled. */
	error?: { message: string; code?: string } | null
}

/** POST /net/mock/remove request payload. */
export type NetMockRemoveRequest = {
	/** Rule id to remove. */
	id: number
}

/** POST /net/mock/remove response. */
export type NetMockRemoveResponse = {
	ok: true
	/** True when a rule with the given id existed and was removed. */
	removed: boolean
	/** Whether Fetch interception remains active after the removal. */
	enabled: boolean
}

/** POST /net/mock/clear response. */
export type NetMockClearResponse = {
	ok: true
	/** Number of rules removed. */
	removed: number
	/** Whether Fetch interception remains active (always false after clear unless disable failed). */
	enabled: boolean
}

/** GET /net/mock response. */
export type NetMockStatusResponse = {
	ok: true
	/** Whether the watcher is currently attached to a CDP target. */
	attached: boolean
	/** Whether Fetch interception is active on the attached target. */
	enabled: boolean
	/** Installed rules in match order (first match wins). */
	rules: NetMockRule[]
	/** Last interception error (enable/disable or action failure), if any. */
	lastError?: { message: string; code?: string } | null
}
