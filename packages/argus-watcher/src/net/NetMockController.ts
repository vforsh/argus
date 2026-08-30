import type { CdpMethod, CdpParams } from '../cdp/protocol.js'
import type {
	NetMockAddRequest,
	NetMockAddResponse,
	NetMockClearResponse,
	NetMockHeader,
	NetMockRemoveResponse,
	NetMockRule,
	NetMockScope,
	NetMockStatusResponse,
} from '@vforsh/argus-core'
import { NetMockInterception, type NetMockInterceptionBinding, type NetMockPausedRequest } from './NetMockInterception.js'

type NetMockError = { message: string; code?: string }

type InternalRule = NetMockRule & {
	/** Compiled URL matcher, built once when the rule is added. */
	urlRegex: RegExp
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

export const createNetMockController = (): NetMockController => {
	let lastError: NetMockError | null = null
	let nextRuleId = 1
	const rules: InternalRule[] = []

	const recordError = (error: unknown): void => {
		lastError = { message: error instanceof Error ? error.message : String(error) }
		const code = (error as { code?: unknown })?.code
		if (typeof code === 'string') {
			lastError.code = code
		}
	}

	const interception = new NetMockInterception((request) => void handleRequestPaused(request), recordError)

	const bind = (binding: NetMockInterceptionBinding): void => {
		interception.bind(binding)
		void interception.reconcile(getActiveScopes(rules))
	}

	const handleRequestPaused = async (paused: NetMockPausedRequest): Promise<void> => {
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
			await sleep(rule.delayMs)
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
			const fulfillParams: CdpParams<'Fetch.fulfillRequest'> = { requestId: paused.requestId, responseCode: action.status }
			if (action.headers && action.headers.length > 0) {
				fulfillParams.responseHeaders = action.headers
			}
			if (action.bodyBase64 != null) {
				fulfillParams.body = action.bodyBase64
			}
			await sendAction(paused, 'Fetch.fulfillRequest', fulfillParams)
			return
		}

		// action.kind === 'continue'
		const continueParams: CdpParams<'Fetch.continueRequest'> = { requestId: paused.requestId }
		if (action.rewriteHost) {
			const rewritten = rewriteUrlHost(paused.url, action.rewriteHost)
			if (rewritten) {
				continueParams.url = rewritten
			}
		}
		if (action.setHeaders && action.setHeaders.length > 0) {
			continueParams.headers = mergeHeaders(paused.headers, action.setHeaders)
		}
		await sendAction(paused, 'Fetch.continueRequest', continueParams)
	}

	/**
	 * Resolve a paused request. Failures are expected when the request was
	 * canceled mid-flight (navigation, tab close) — those are swallowed so a
	 * noisy page cannot poison `lastError`.
	 */
	const sendAction = async <M extends CdpMethod>(request: NetMockPausedRequest, cdpMethod: M, params: CdpParams<M>): Promise<void> =>
		interception.sendRequestCommand(request, cdpMethod, params)

	const getStatus = (ctx: { attached: boolean }): NetMockStatusResponse => ({
		ok: true,
		attached: ctx.attached,
		enabled: interception.enabled,
		rules: rules.map(toPublicRule),
		lastError,
	})

	const addRule = async (input: NetMockAddRequest, attached: boolean): Promise<NetMockAddResponse> => {
		lastError = null
		const rule: InternalRule = {
			id: nextRuleId++,
			scope: input.scope ?? 'page',
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

		const applied = await interception.reconcile(getActiveScopes(rules))
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
		interception.onDetach()
	}

	return { bind, getStatus, addRule, removeRule, clearRules, onAttach, onTargetChanged, onDetach }
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
