import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import {
	compact,
	optionalEnum,
	optionalInteger,
	optionalNumber,
	optionalString,
	optionalStringArray,
	readFields,
	requireObject,
} from '../schemaFields.js'
import type { LogEpoch } from '../logs.js'
import type { Ok } from './errors.js'

/**
 * How long a navigation command waits before it answers.
 *
 * - `load` — the page's `load` event fired. The default, and what "the page is ready" means
 *   to most callers.
 * - `domcontentloaded` — the DOM is parsed but subresources may still be in flight. Use it
 *   for pages whose `load` is gated on a slow image, video, or analytics beacon.
 * - `none` — return as soon as Chrome accepts the command. Nothing is guaranteed to have
 *   happened yet; the reported URL is the requested one, not the resolved one.
 *
 * There is deliberately no `networkidle`: it is a heuristic, not an event, and a page with a
 * long-poll or an open socket never reaches it.
 */
export type NavigationWait = 'load' | 'domcontentloaded' | 'none'

/** Runtime list of the wait modes, for enum validation and CLI help text. */
export const NAVIGATION_WAITS = ['load', 'domcontentloaded', 'none'] as const

/** Default wait mode when a request does not name one. */
export const DEFAULT_NAVIGATION_WAIT: NavigationWait = 'load'

/** Default wait timeout in milliseconds. Applies to the wait, not to the command itself. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/** Directions accepted by POST /navigate/history. */
export const NAVIGATION_DIRECTIONS = ['back', 'forward'] as const

/** Which way through the session history to move. */
export type NavigationDirection = (typeof NAVIGATION_DIRECTIONS)[number]

/**
 * Request payload for POST /navigate.
 *
 * At least one of `url`, `param`, or `params` is required. Omitting `url` rewrites the query
 * string of the page's current URL in place, which is how `goto --param x=1` works without
 * the caller having to read the URL first.
 */
export type NavigateRequest = {
	/** Absolute, scheme-less, or relative to the page's current URL. Resolved by the watcher. */
	url?: string
	/** Query overrides applied after resolution, overwrite semantics. Repeatable `key=value`. */
	param?: string[]
	/** Query overrides as a single `a=b&c=d` string. Applied before `param`. */
	params?: string
	/** How long to wait before answering. Default: `load`. */
	wait?: NavigationWait
	/** Wait budget in milliseconds. Default: 30000. Applies to the wait only. */
	timeoutMs?: number
}

/** Response payload for POST /navigate. */
export type NavigateResponse = Ok<{
	/** The URL Argus asked Chrome for, after relative resolution and query merging. */
	requestedUrl: string
	/**
	 * The top-frame URL after navigation, so a redirect reports where the page actually landed.
	 * Equal to `requestedUrl` when `wait` is `none`, since nothing has been observed yet.
	 */
	url: string
	/** Chrome's loader id for this navigation, when it reported one. */
	loaderId: string | null
	/**
	 * Log epoch opened immediately before the navigation was dispatched.
	 *
	 * Everything the new page logs lands after it, so `logs --since-epoch <epoch>` is race-free
	 * even for a console line written during the very first script of the new document.
	 */
	epoch: LogEpoch
	/** The wait mode that was actually applied. */
	waited: NavigationWait
}>

/** Request payload for POST /navigate/history. */
export type NavigateHistoryRequest = {
	/** Which way to move through the session history. */
	direction: NavigationDirection
	/** How many entries to move. Default: 1. */
	steps?: number
	/** How long to wait before answering. Default: `load`. */
	wait?: NavigationWait
	/** Wait budget in milliseconds. Default: 30000. */
	timeoutMs?: number
}

/** Response payload for POST /navigate/history. */
export type NavigateHistoryResponse = Ok<{
	/** The top-frame URL after the history entry loaded. */
	url: string
	/** Resulting position in the session history (0-based). */
	index: number
	/** Number of entries in the session history. */
	length: number
	/** Log epoch opened immediately before the history entry was dispatched. */
	epoch: LogEpoch
	/** The wait mode that was actually applied. */
	waited: NavigationWait
}>

/**
 * What a `--wait-nav` interaction observed after it acted.
 *
 * `navigated: false` is a success, not a failure: clicking a button that does not navigate is
 * the normal case, and so is an iframe-internal navigation — only a top-frame navigation counts.
 */
export type NavigationSummary = {
	/** Whether a top-frame navigation completed within the wait budget. */
	navigated: boolean
	/** The new top-frame URL, or `null` when nothing navigated. */
	url: string | null
	/** Log epoch opened before the interaction, or `null` when no wait was requested. */
	epoch: LogEpoch | null
}

/** Shared `--wait-nav` fields carried by interaction requests that can trigger a navigation. */
export type NavigationWaitOptions = {
	/** Wait for a top-frame navigation after the interaction. Omit to not wait at all. */
	waitNav?: NavigationWait
	/** Wait budget for `waitNav`, in milliseconds. Default: 10000. */
	navTimeoutMs?: number
}

/** Default wait budget for `waitNav` on an interaction, which is a much shorter bet than a goto. */
export const DEFAULT_INTERACTION_NAV_TIMEOUT_MS = 10_000

/** Read a wait mode. Same reader under both field names (`wait` and `waitNav`). */
const readWait = (source: Record<string, unknown>, key: string) => optionalEnum(source, key, NAVIGATION_WAITS)

/** Read a wait budget. Same reader under both field names (`timeoutMs` and `navTimeoutMs`). */
const readTimeoutMs = (source: Record<string, unknown>, key: string) => optionalNumber(source, key, { min: 0 })

/** Wait fields shared by both navigation schemas. */
const waitFields = { wait: readWait, timeoutMs: readTimeoutMs }

/**
 * Read the optional `waitNav` / `navTimeoutMs` pair off an interaction payload.
 *
 * Exported so `/dom/click` and `/dom/keydown` compose the same two fields instead of each
 * spelling out the enum and the bound.
 */
export const navigationWaitFields = { waitNav: readWait, navTimeoutMs: readTimeoutMs }

/** Schema for POST /navigate request payloads. */
export const navigateRequestSchema = defineProtocolSchema<NavigateRequest>((value) => {
	const invalid = requireObject<NavigateRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		url: optionalString,
		param: optionalStringArray,
		params: optionalString,
		...waitFields,
	})
	if (!fields.ok) return fields

	const { url, param, params } = fields.value
	if (url != null && url.trim() === '') {
		return invalidProtocolPayload('url must be a non-empty string')
	}

	const hasParam = (param?.length ?? 0) > 0
	if (url == null && !hasParam && params == null) {
		return invalidProtocolPayload('at least one of url, param, or params is required')
	}

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /navigate/history request payloads. */
export const navigateHistoryRequestSchema = defineProtocolSchema<NavigateHistoryRequest>((value) => {
	const invalid = requireObject<NavigateHistoryRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		direction: (source, key) => optionalEnum(source, key, NAVIGATION_DIRECTIONS),
		steps: (source, key) => optionalInteger(source, key, { min: 1 }),
		...waitFields,
	})
	if (!fields.ok) return fields

	if (fields.value.direction == null) {
		return invalidProtocolPayload(`direction must be one of: ${NAVIGATION_DIRECTIONS.join(', ')}`)
	}

	return validProtocolPayload(compact({ ...fields.value, direction: fields.value.direction }))
})
