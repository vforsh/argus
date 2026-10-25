import { STATUS_CODES } from 'node:http'
import type { CdpMethod, CdpParams } from '../cdp/protocol.js'
import type {
	NetMockAction,
	NetMockAddRequest,
	NetMockAddResponse,
	NetMockClearResponse,
	NetMockHeader,
	NetMockRemoveResponse,
	NetMockResponseAction,
	NetMockRule,
	NetMockScope,
	NetMockStatusResponse,
	ErrorDetail,
} from '@vforsh/argus-core'
import { NetMockInterception, type NetMockInterceptionBinding, type NetMockPausedRequest } from './NetMockInterception.js'
import { getErrorCode } from '../errors.js'
import { formatError } from '@vforsh/argus-core'
import { delay } from '@vforsh/argus-core'

type InternalRule = NetMockRule & {
	/** Compiled URL matcher, built once when the rule is added. */
	urlRegex: RegExp
}

/** Response-stage actions waiting for their request's response; bounded because canceled requests never resolve. */
const MAX_PENDING_RESPONSES = 1_000

/** Headers that describe the original wire encoding and become wrong once the body is replaced. */
const STALE_BODY_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding'])

/**
 * Watcher-side network mocking via the CDP `Fetch` domain.
 *
 * Rules are stored in the watcher and survive page reloads and target
 * reattachment: `onAttach` re-arms interception whenever rules exist.
 * Interception is enabled lazily on the first rule and disabled when the last
 * rule is removed, so an idle watcher adds zero request latency.
 *
 * Interception always pauses at the request stage. `response` rules opt their
 * matched request into a second pause with `interceptResponse: true`, so only
 * those requests pay the response-stage round trip.
 */
export type NetMockController = {
	/** Subscribe to `Fetch.requestPaused` and provide page/selected target routing. Call once at startup. */
	bind: (binding: NetMockInterceptionBinding) => void
	getStatus: (ctx: { attached: boolean }) => NetMockStatusResponse
	addRule: (input: NetMockAddRequest, attached: boolean) => Promise<NetMockAddResponse>
	removeRule: (id: number) => Promise<NetMockRemoveResponse>
	clearRules: () => Promise<NetMockClearResponse>
	/** Re-arm interception on a freshly attached target when rules exist. */
	onAttach: () => Promise<void>
	/** Move selected-scope interception when iframe selection changes. */
	onTargetChanged: () => Promise<void>
	/** Mark interception as inactive after the target detached. */
	onDetach: () => void
}

const PAGE_RULE_ON_IFRAME_WARNINGS = {
	oopif: 'This watcher has an out-of-process iframe selected, but the rule is page-scoped, so requests from that iframe never match it. Use --scope selected to mock the iframe.',
	'same-process':
		'This watcher has an iframe selected, but the rule is page-scoped, so it matches requests from every frame of the page. Use --scope selected to mock only the iframe.',
} as const

export const createNetMockController = (): NetMockController => {
	let lastError: ErrorDetail | null = null
	let nextRuleId = 1
	const rules: InternalRule[] = []
	/** Keyed by session + Fetch request id, which CDP keeps across the request and response stages. */
	const pendingResponses = new Map<string, NetMockResponseAction>()

	const recordError = (error: unknown): void => {
		lastError = { message: formatError(error) }
		const code = getErrorCode(error)
		if (code) {
			lastError.code = code
		}
	}

	const interception = new NetMockInterception((request) => void handleRequestPaused(request), recordError)

	const bind = (binding: NetMockInterceptionBinding): void => {
		interception.bind(binding)
		void interception.reconcile(getActiveScopes(rules))
	}

	const handleRequestPaused = async (paused: NetMockPausedRequest): Promise<void> => {
		if (paused.response) {
			await handleResponsePaused(paused)
			return
		}

		const rule = rules.find(
			(candidate) =>
				interception.matchesScope(candidate.scope ?? 'page', paused) &&
				ruleMatches(candidate, paused.url, paused.method, paused.resourceType),
		)

		if (!rule) {
			await sendAction(paused, 'Fetch.continueRequest', { requestId: paused.requestId })
			return
		}

		rule.hits += 1

		if (rule.delayMs && rule.delayMs > 0) {
			await delay(rule.delayMs)
		}

		const action = rule.action
		if (action.kind === 'block') {
			await sendAction(paused, 'Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' })
			return
		}
		if (action.kind === 'fail') {
			await sendAction(paused, 'Fetch.failRequest', { requestId: paused.requestId, errorReason: action.reason })
			return
		}
		if (action.kind === 'fulfill') {
			const fulfillParams: CdpParams<'Fetch.fulfillRequest'> = {
				requestId: paused.requestId,
				responseCode: action.status,
				// Chrome rejects a status without a standard reason phrase (e.g. 299) unless one is given.
				responsePhrase: STATUS_CODES[action.status] ?? 'Mocked',
			}
			if (action.headers && action.headers.length > 0) {
				fulfillParams.responseHeaders = action.headers
			}
			if (action.bodyBase64 != null) {
				fulfillParams.body = action.bodyBase64
			}
			await sendAction(paused, 'Fetch.fulfillRequest', fulfillParams)
			return
		}

		const continueParams = buildContinueParams(paused, action)
		if (action.kind === 'response') {
			rememberPendingResponse(paused, action)
			continueParams.interceptResponse = true
		}
		await sendAction(paused, 'Fetch.continueRequest', continueParams)
	}

	const rememberPendingResponse = (paused: NetMockPausedRequest, action: NetMockResponseAction): void => {
		if (pendingResponses.size >= MAX_PENDING_RESPONSES) {
			const oldest = pendingResponses.keys().next().value
			if (oldest !== undefined) {
				pendingResponses.delete(oldest)
			}
		}
		pendingResponses.set(pendingResponseKey(paused), action)
	}

	/** Apply a `response` rule to the real server response its request was forwarded for. */
	const handleResponsePaused = async (paused: NetMockPausedRequest): Promise<void> => {
		const key = pendingResponseKey(paused)
		const action = pendingResponses.get(key)
		pendingResponses.delete(key)
		const response = paused.response
		if (!action || !response || response.errorReason != null || response.statusCode == null) {
			await sendAction(paused, 'Fetch.continueRequest', { requestId: paused.requestId })
			return
		}

		if (action.delayMs && action.delayMs > 0) {
			await delay(action.delayMs)
		}

		if (action.fail) {
			await sendAction(paused, 'Fetch.failRequest', { requestId: paused.requestId, errorReason: action.fail })
			return
		}

		if (action.patchJson !== undefined && !isRedirectStatus(response.statusCode)) {
			const body = await readPatchedJsonBody(paused, action.patchJson)
			if (body != null) {
				await sendAction(paused, 'Fetch.fulfillRequest', {
					requestId: paused.requestId,
					responseCode: response.statusCode,
					responsePhrase: response.statusText || STATUS_CODES[response.statusCode] || 'Mocked',
					responseHeaders: response.headers.filter((header) => !STALE_BODY_HEADERS.has(header.name.toLowerCase())),
					body: Buffer.from(body, 'utf8').toString('base64'),
				})
				return
			}
		}

		await sendAction(paused, 'Fetch.continueRequest', { requestId: paused.requestId })
	}

	/** Merge-patch the real JSON body; null (with `lastError` set) when the body is unavailable or not JSON. */
	const readPatchedJsonBody = async (paused: NetMockPausedRequest, patch: unknown): Promise<string | null> => {
		const raw = await interception.readResponseBody(paused)
		if (!raw) {
			return null
		}

		const text = raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString('utf8') : raw.body
		try {
			return JSON.stringify(applyJsonMergePatch(JSON.parse(text), patch))
		} catch {
			recordError(new Error(`Cannot apply patchJson: response body of ${paused.url} is not JSON`))
			return null
		}
	}

	/**
	 * Resolve a paused request. Failures are expected when the request was
	 * canceled mid-flight (navigation, tab close) — those are swallowed so a
	 * noisy page cannot poison `lastError`. Any other failure (e.g. CDP rejecting
	 * the mocked response) is recorded in `lastError`, and the request is failed
	 * instead so the page never hangs on a request that stays paused forever.
	 */
	const sendAction = async <M extends CdpMethod>(request: NetMockPausedRequest, cdpMethod: M, params: CdpParams<M>): Promise<void> => {
		if (await interception.sendRequestCommand(request, cdpMethod, params)) {
			return
		}
		const fallback: CdpParams<'Fetch.failRequest'> = { requestId: request.requestId, errorReason: 'Failed' }
		if (cdpMethod === 'Fetch.failRequest' && (params as CdpParams<'Fetch.failRequest'>).errorReason === fallback.errorReason) {
			return
		}
		await interception.sendRequestCommand(request, 'Fetch.failRequest', fallback)
	}

	const getStatus = (ctx: { attached: boolean }): NetMockStatusResponse => ({
		ok: true,
		attached: ctx.attached,
		enabled: interception.enabled,
		rules: rules.map(toPublicRule),
		lastError,
	})

	const addRule = async (input: NetMockAddRequest, attached: boolean): Promise<NetMockAddResponse> => {
		lastError = null
		// A rule without an explicit scope follows the watcher's selection: an iframe watcher mocks
		// its iframe, since a page rule never sees requests from an out-of-process frame.
		const selectedChildFrame = interception.describeSelectedChildFrame()
		const scope: NetMockScope = input.scope ?? (selectedChildFrame ? 'selected' : 'page')
		const warning = scope === 'page' && selectedChildFrame ? PAGE_RULE_ON_IFRAME_WARNINGS[selectedChildFrame] : null
		const rule: InternalRule = {
			id: nextRuleId++,
			scope,
			match: input.match,
			action: input.action,
			delayMs: input.delayMs,
			times: input.times,
			hits: 0,
			createdAt: Date.now(),
			urlRegex: compileUrlPattern(input.match.url),
		}
		rules.push(rule)

		if (!attached) {
			return { ok: true, attached: false, enabled: false, rule: toPublicRule(rule), warning }
		}

		const applied = await interception.reconcile(getActiveScopes(rules))
		return {
			ok: true,
			attached: true,
			enabled: applied,
			rule: toPublicRule(rule),
			error: applied ? null : lastError,
			warning,
		}
	}

	const removeRule = async (id: number): Promise<NetMockRemoveResponse> => {
		const index = rules.findIndex((rule) => rule.id === id)
		const removed = index >= 0
		if (removed) {
			rules.splice(index, 1)
		}
		if (rules.length === 0) {
			await interception.reconcile(new Set())
		} else {
			await interception.reconcile(getActiveScopes(rules))
		}
		return { ok: true, removed, enabled: interception.enabled }
	}

	const clearRules = async (): Promise<NetMockClearResponse> => {
		const removed = rules.length
		rules.length = 0
		await interception.reconcile(new Set())
		return { ok: true, removed, enabled: interception.enabled }
	}

	const onAttach = async (): Promise<void> => {
		const applied = await interception.reconcile(getActiveScopes(rules), true)
		if (!applied && lastError) {
			console.warn(`[NetMock] Failed to re-enable interception on attach: ${lastError.message}`)
		}
	}

	const onTargetChanged = async (): Promise<void> => {
		await interception.reconcile(getActiveScopes(rules))
	}

	const onDetach = (): void => {
		pendingResponses.clear()
		interception.onDetach()
	}

	return { bind, getStatus, addRule, removeRule, clearRules, onAttach, onTargetChanged, onDetach }
}

const pendingResponseKey = (request: NetMockPausedRequest): string => `${request.sessionId ?? 'page'}:${request.requestId}`

/** Request-stage continue parameters shared by `continue` and `response` rules. */
const buildContinueParams = (
	paused: NetMockPausedRequest,
	action: Extract<NetMockAction, { kind: 'continue' | 'response' }>,
): CdpParams<'Fetch.continueRequest'> => {
	const params: CdpParams<'Fetch.continueRequest'> = { requestId: paused.requestId }
	if (action.rewriteHost) {
		const rewritten = rewriteUrlHost(paused.url, action.rewriteHost)
		if (rewritten) {
			params.url = rewritten
		}
	}
	if (action.setHeaders && action.setHeaders.length > 0) {
		params.headers = mergeHeaders(paused.headers, action.setHeaders)
	}
	return params
}

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400

/** RFC 7396 JSON merge patch: objects merge recursively, `null` deletes a key, anything else replaces. */
const applyJsonMergePatch = (target: unknown, patch: unknown): unknown => {
	if (!isJsonObject(patch)) {
		return patch
	}

	const result: Record<string, unknown> = isJsonObject(target) ? { ...target } : {}
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key]
		} else {
			result[key] = applyJsonMergePatch(result[key], value)
		}
	}
	return result
}

const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const getActiveScopes = (rules: InternalRule[]): Set<NetMockScope> => new Set(rules.filter(isRuleActive).map((rule) => rule.scope ?? 'page'))

const isRuleActive = (rule: InternalRule): boolean => rule.times == null || rule.hits < rule.times

const ruleMatches = (rule: InternalRule, url: string, method: string, resourceType: string): boolean => {
	if (!isRuleActive(rule)) {
		return false
	}
	if (rule.match.method && rule.match.method.toUpperCase() !== method.toUpperCase()) {
		return false
	}
	if (rule.match.resourceType && rule.match.resourceType.toLowerCase() !== resourceType.toLowerCase()) {
		return false
	}
	return rule.urlRegex.test(url)
}

/**
 * Compile a wildcard URL pattern. `*` matches any run of characters; a pattern
 * without `*` matches as a substring. Matching is case-insensitive.
 */
const compileUrlPattern = (pattern: string): RegExp => {
	const normalized = pattern.includes('*') ? pattern : `*${pattern}*`
	const source = normalized
		.split('*')
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*')
	return new RegExp(`^${source}$`, 'i')
}

/** Replace the host (or full origin when the value contains `://`) of a request URL. */
const rewriteUrlHost = (rawUrl: string, rewriteHost: string): string | null => {
	try {
		const url = new URL(rawUrl)
		if (rewriteHost.includes('://')) {
			const target = new URL(rewriteHost)
			url.protocol = target.protocol
			url.host = target.host
		} else {
			url.host = rewriteHost
		}
		return url.toString()
	} catch {
		return null
	}
}

/** Merge override headers into the original request headers (case-insensitive on name). */
const mergeHeaders = (original: Record<string, string>, overrides: NetMockHeader[]): NetMockHeader[] => {
	const merged = new Map<string, NetMockHeader>()
	for (const [name, value] of Object.entries(original)) {
		merged.set(name.toLowerCase(), { name, value })
	}
	for (const header of overrides) {
		merged.set(header.name.toLowerCase(), header)
	}
	return [...merged.values()]
}

const toPublicRule = (rule: InternalRule): NetMockRule => ({
	id: rule.id,
	scope: rule.scope ?? 'page',
	match: rule.match,
	action: rule.action,
	delayMs: rule.delayMs,
	times: rule.times,
	hits: rule.hits,
	createdAt: rule.createdAt,
})

