import type {
	NetMockAddRequest,
	NetMockAddResponse,
	NetMockClearResponse,
	NetMockHeader,
	NetMockRemoveResponse,
	NetMockRule,
	NetMockStatusResponse,
} from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'

type NetMockError = { message: string; code?: string }

type InternalRule = NetMockRule & {
	/** Compiled URL matcher, built once when the rule is added. */
	urlRegex: RegExp
}

type FetchRequestPausedParams = {
	requestId?: string
	request?: {
		url?: string
		method?: string
		headers?: Record<string, string>
	}
	resourceType?: string
}

/**
 * Watcher-side network mocking via the CDP `Fetch` domain.
 *
 * Rules are stored in the watcher and survive page reloads and target
 * reattachment: `onAttach` re-arms interception whenever rules exist.
 * Interception is enabled lazily on the first rule and disabled when the last
 * rule is removed, so an idle watcher adds zero request latency.
 */
export type NetMockController = {
	/** Subscribe to `Fetch.requestPaused` on the watcher session. Call once at startup. */
	bind: (session: CdpSessionHandle) => void
	getStatus: (ctx: { attached: boolean }) => NetMockStatusResponse
	addRule: (input: NetMockAddRequest, attached: boolean) => Promise<NetMockAddResponse>
	removeRule: (id: number) => Promise<NetMockRemoveResponse>
	clearRules: () => Promise<NetMockClearResponse>
	/** Re-arm interception on a freshly attached target when rules exist. */
	onAttach: (session: CdpSessionHandle) => Promise<void>
	/** Mark interception as inactive after the target detached. */
	onDetach: () => void
}

export const createNetMockController = (): NetMockController => {
	let session: CdpSessionHandle | null = null
	let bound = false
	let enabled = false
	let lastError: NetMockError | null = null
	let nextRuleId = 1
	const rules: InternalRule[] = []

	const hasActiveRules = (): boolean => rules.some(isRuleActive)

	const recordError = (error: unknown): void => {
		lastError = { message: error instanceof Error ? error.message : String(error) }
		const code = (error as { code?: unknown })?.code
		if (typeof code === 'string') {
			lastError.code = code
		}
	}

	const enableInterception = async (): Promise<boolean> => {
		if (!session || !session.isAttached()) {
			enabled = false
			return false
		}
		try {
			await session.sendAndWait('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
			enabled = true
			return true
		} catch (error) {
			enabled = false
			recordError(error)
			return false
		}
	}

	const disableInterception = async (): Promise<void> => {
		if (!enabled) {
			return
		}
		enabled = false
		if (!session || !session.isAttached()) {
			return
		}
		try {
			await session.sendAndWait('Fetch.disable')
		} catch (error) {
			recordError(error)
		}
	}

	const bind = (nextSession: CdpSessionHandle): void => {
		session = nextSession
		if (bound) {
			return
		}
		bound = true
		nextSession.onEvent('Fetch.requestPaused', (params) => {
			void handleRequestPaused(params)
		})
	}

	const handleRequestPaused = async (params: unknown): Promise<void> => {
		const paused = params as FetchRequestPausedParams
		const requestId = paused?.requestId
		if (typeof requestId !== 'string' || requestId === '') {
			return
		}

		const url = paused.request?.url ?? ''
		const method = paused.request?.method ?? 'GET'
		const resourceType = paused.resourceType ?? ''
		const rule = rules.find((candidate) => ruleMatches(candidate, url, method, resourceType))

		if (!rule) {
			await sendAction('Fetch.continueRequest', { requestId })
			return
		}

		rule.hits += 1

		if (rule.delayMs && rule.delayMs > 0) {
			await sleep(rule.delayMs)
		}

		const action = rule.action
		if (action.kind === 'block') {
			await sendAction('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
			return
		}
		if (action.kind === 'fail') {
			await sendAction('Fetch.failRequest', { requestId, errorReason: action.reason })
			return
		}
		if (action.kind === 'fulfill') {
			const fulfillParams: Record<string, unknown> = { requestId, responseCode: action.status }
			if (action.headers && action.headers.length > 0) {
				fulfillParams.responseHeaders = action.headers
			}
			if (action.bodyBase64 != null) {
				fulfillParams.body = action.bodyBase64
			}
			await sendAction('Fetch.fulfillRequest', fulfillParams)
			return
		}

		// action.kind === 'continue'
		const continueParams: Record<string, unknown> = { requestId }
		if (action.rewriteHost) {
			const rewritten = rewriteUrlHost(url, action.rewriteHost)
			if (rewritten) {
				continueParams.url = rewritten
			}
		}
		if (action.setHeaders && action.setHeaders.length > 0) {
			continueParams.headers = mergeHeaders(paused.request?.headers ?? {}, action.setHeaders)
		}
		await sendAction('Fetch.continueRequest', continueParams)
	}

	/**
	 * Resolve a paused request. Failures are expected when the request was
	 * canceled mid-flight (navigation, tab close) — those are swallowed so a
	 * noisy page cannot poison `lastError`.
	 */
	const sendAction = async (cdpMethod: string, params: Record<string, unknown>): Promise<void> => {
		if (!session || !session.isAttached()) {
			return
		}
		try {
			await session.sendAndWait(cdpMethod, params)
		} catch (error) {
			if (isBenignInterceptionError(error)) {
				return
			}
			recordError(error)
		}
	}

	const getStatus = (ctx: { attached: boolean }): NetMockStatusResponse => ({
		ok: true,
		attached: ctx.attached,
		enabled,
		rules: rules.map(toPublicRule),
		lastError,
	})

	const addRule = async (input: NetMockAddRequest, attached: boolean): Promise<NetMockAddResponse> => {
		lastError = null
		const rule: InternalRule = {
			id: nextRuleId++,
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
			return { ok: true, attached: false, enabled: false, rule: toPublicRule(rule) }
		}

		const applied = enabled || (await enableInterception())
		return {
			ok: true,
			attached: true,
			enabled: applied,
			rule: toPublicRule(rule),
			error: applied ? null : lastError,
		}
	}

	const removeRule = async (id: number): Promise<NetMockRemoveResponse> => {
		const index = rules.findIndex((rule) => rule.id === id)
		const removed = index >= 0
		if (removed) {
			rules.splice(index, 1)
		}
		if (rules.length === 0) {
			await disableInterception()
		}
		return { ok: true, removed, enabled }
	}

	const clearRules = async (): Promise<NetMockClearResponse> => {
		const removed = rules.length
		rules.length = 0
		await disableInterception()
		return { ok: true, removed, enabled }
	}

	const onAttach = async (nextSession: CdpSessionHandle): Promise<void> => {
		session = nextSession
		enabled = false
		if (!hasActiveRules()) {
			return
		}
		const applied = await enableInterception()
		if (!applied && lastError) {
			console.warn(`[NetMock] Failed to re-enable interception on attach: ${lastError.message}`)
		}
	}

	const onDetach = (): void => {
		enabled = false
	}

	return { bind, getStatus, addRule, removeRule, clearRules, onAttach, onDetach }
}

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

const isBenignInterceptionError = (error: unknown): boolean => {
	const code = (error as { code?: unknown })?.code
	if (code === 'cdp_not_attached') {
		return true
	}
	const message = error instanceof Error ? error.message : String(error)
	return message.includes('Invalid InterceptionId') || message.includes('Inspected target navigated or closed')
}

const toPublicRule = (rule: InternalRule): NetMockRule => ({
	id: rule.id,
	match: rule.match,
	action: rule.action,
	delayMs: rule.delayMs,
	times: rule.times,
	hits: rule.hits,
	createdAt: rule.createdAt,
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
