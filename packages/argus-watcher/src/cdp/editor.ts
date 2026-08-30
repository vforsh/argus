import type { CdpResult } from './protocol.js'
import {
	matchesTextPattern,
	parseTextPattern,
	type CodeEditResponse,
	type CodeGrepMatch,
	type CodeGrepResponse,
	type CodeGrepSkippedResource,
	type CodeListResponse,
	type CodeReadResponse,
	type CodeResource,
	type CodeResourceType,
} from '@vforsh/argus-core'
import type { CdpEventMeta, CdpSessionHandle } from './connection.js'
import { formatError } from '@vforsh/argus-core'

type RuntimeResource = {
	type: CodeResourceType
	url: string
	id: string
	sessionId: string | null
}

type DebuggerScriptParsedParams = {
	scriptId?: string
	url?: string
}

type CssStyleSheetAddedParams = {
	header?: {
		styleSheetId?: string
		sourceURL?: string
	}
}

type CssStyleSheetRemovedParams = {
	styleSheetId?: string
}

const INLINE_SCRIPT_PREFIX = 'inline://'
const INLINE_STYLESHEET_PREFIX = 'inline-css://'
const QUIET_PERIOD_MS = 100
const ENABLE_TIMEOUT_MS = 5_000
const DEFAULT_READ_LIMIT = 2_000
const MAX_GREP_MATCHES = 500

export type RuntimeEditor = {
	list: (options?: { pattern?: string }) => Promise<CodeListResponse>
	read: (options: { url: string; offset?: number; limit?: number }) => Promise<CodeReadResponse>
	grep: (options: { pattern: string; urlPattern?: string }) => Promise<CodeGrepResponse>
	edit: (options: { url: string; source: string }) => Promise<CodeEditResponse>
	/**
	 * The page navigated: drop the inventory, keep the enable.
	 *
	 * Deliberately leaves the editor enabled and its listeners bound. CDP domains and their event
	 * subscriptions survive a navigation on the same target, so the new document's `scriptParsed` and
	 * `styleSheetAdded` events repopulate the inventory through the listeners that are already there.
	 */
	reset: () => void
	/**
	 * The watcher (re)attached: the old connection is gone.
	 *
	 * Unbinds the listeners (their subscriptions died with the old session), drops the inventory, and
	 * clears `enabled` so the next command enables the domains again on the new target.
	 */
	rebind: () => void
}

/**
 * Runtime JS/CSS inspector backed by CDP Debugger + CSS domains.
 *
 * **Lifecycle.** Four pieces of state, and the reason each exists:
 *
 * - `scripts` / `stylesheets` / `sources` — the inventory. Never fetched; it is assembled purely
 *   from CDP events, and `sources` caches text per resource handle.
 * - `enabled` — the three domains are on *for the current CDP connection* and the inventory has
 *   settled. Enabling is lazy: nothing here runs until an `argus code` command asks, because
 *   `Debugger.enable` is not free for a page the watcher is only meant to be observing.
 * - `enabling` — the in-flight enable, so two concurrent commands share one round-trip instead of
 *   racing two `Debugger.enable` calls.
 * - `listenersBound` / `listenerDisposers` — whether the three event subscriptions exist on this
 *   session handle. Bound on the first `ensureEnabled`, and only torn down by {@link RuntimeEditor.rebind}.
 *
 * **The quiet period.** `*.enable` makes Chrome replay every already-parsed script and stylesheet,
 * with no "that's all" marker. `waitForResourceQuietPeriod` therefore treats 100 ms without a
 * resource event as the end of the replay, which is what makes the first `list()` complete rather
 * than a snapshot of however much had arrived. Every later resource event also touches that timer,
 * so a command issued mid-navigation waits for the new document to settle too.
 *
 * **Where this breaks.** `reset()` keeping `enabled === true` reads like a bug until you know
 * domains survive navigation — change it to `false` and every navigation pays a redundant
 * three-command enable. Conversely `rebind()` *must* clear it: the flag describes a connection, not
 * a page. Both hooks are called from `startWatcherRuntime`, on `onPageNavigation` and `onAttach`.
 */
export const createRuntimeEditor = (session: CdpSessionHandle): RuntimeEditor => {
	const scripts = new Map<string, RuntimeResource>()
	const stylesheets = new Map<string, RuntimeResource>()
	const sources = new Map<string, string>()
	let enabled = false
	let enabling: Promise<void> | null = null
	let settleTimer: NodeJS.Timeout | null = null
	const settleResolvers = new Set<() => void>()
	let listenersBound = false
	let listenerDisposers: Array<() => void> = []

	return {
		list: async (options = {}) => {
			await ensureEnabled()
			const pattern = normalizeSearchPattern(options.pattern)
			const resources = getResources().filter((resource) => matchesUrlPattern(resource, pattern))
			return {
				ok: true,
				resources: resources.map(toCodeResource),
			}
		},

		read: async ({ url, offset = 0, limit = DEFAULT_READ_LIMIT }) => {
			await ensureEnabled()
			const resource = getResource(url)
			const source = await getSource(resource)
			const lines = source.split('\n')
			const totalLines = lines.length
			const startLineIndex = Math.min(Math.max(0, offset), totalLines)
			const endLineIndex = Math.min(startLineIndex + Math.max(1, limit), totalLines)
			const content = lines
				.slice(startLineIndex, endLineIndex)
				.map((line, index) => `${String(startLineIndex + index + 1).padStart(5)}| ${line}`)
				.join('\n')

			return {
				ok: true,
				resource: toCodeResource(resource),
				source: lines.slice(startLineIndex, endLineIndex).join('\n'),
				content,
				totalLines,
				startLine: startLineIndex + 1,
				endLine: endLineIndex,
			}
		},

		edit: async ({ url, source }) => {
			await ensureEnabled()
			const resource = getResource(url)

			if (resource.type === 'stylesheet') {
				await session.sendAndWait('CSS.setStyleSheetText', { styleSheetId: resource.id, text: source }, getSessionOptions(resource))
			} else {
				await editScript(session, resource, source)
			}

			sources.set(getSourceCacheKey(resource), source)
			return { ok: true, resource: toCodeResource(resource) }
		},

		grep: async ({ pattern, urlPattern }) => {
			await ensureEnabled()
			const parsedPattern = parseTextPattern(pattern)
			const normalizedUrlPattern = normalizeSearchPattern(urlPattern)
			const matches: CodeGrepMatch[] = []
			const skippedResources: CodeGrepSkippedResource[] = []

			for (const resource of getResources()) {
				if (!matchesUrlPattern(resource, normalizedUrlPattern)) {
					continue
				}

				const source = await getSourceForGrep(resource, skippedResources)
				if (source == null) {
					continue
				}

				const lines = source.split('\n')
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index] ?? ''
					if (!matchesLine(line, parsedPattern)) {
						continue
					}

					matches.push({
						url: resource.url,
						type: resource.type,
						lineNumber: index + 1,
						lineContent: line,
					})
					if (matches.length >= MAX_GREP_MATCHES) {
						return { ok: true, matches, skippedResources }
					}
				}
			}

			return { ok: true, matches, skippedResources }
		},
		reset: () => {
			resetState()
		},
		rebind: () => {
			unbindListeners()
			resetState()
			enabled = false
		},
	}

	function handleScriptParsed(params: DebuggerScriptParsedParams, meta: CdpEventMeta): void {
		if (!params.scriptId) {
			return
		}
		registerResource(scripts, {
			type: 'script',
			url: params.url,
			id: params.scriptId,
			inlinePrefix: INLINE_SCRIPT_PREFIX,
			sessionId: meta.sessionId ?? null,
		})
	}

	function handleStyleSheetAdded(params: CssStyleSheetAddedParams, meta: CdpEventMeta): void {
		const styleSheetId = params.header?.styleSheetId
		if (!styleSheetId) {
			return
		}
		registerResource(stylesheets, {
			type: 'stylesheet',
			url: params.header?.sourceURL,
			id: styleSheetId,
			inlinePrefix: INLINE_STYLESHEET_PREFIX,
			sessionId: meta.sessionId ?? null,
		})
	}

	function handleStyleSheetRemoved(params: CssStyleSheetRemovedParams, meta: CdpEventMeta): void {
		if (!params.styleSheetId) {
			return
		}

		removeResourceById(stylesheets, params.styleSheetId, meta.sessionId ?? null)
	}

	async function ensureEnabled(): Promise<void> {
		bindListeners()

		if (enabled) {
			return
		}
		if (enabling) {
			return enabling
		}

		enabling = (async () => {
			clearResourceState()
			await session.sendAndWait('Debugger.enable', undefined, { timeoutMs: ENABLE_TIMEOUT_MS })
			await session.sendAndWait('DOM.enable', undefined, { timeoutMs: ENABLE_TIMEOUT_MS })
			await session.sendAndWait('CSS.enable', undefined, { timeoutMs: ENABLE_TIMEOUT_MS })
			await waitForResourceQuietPeriod()
			enabled = true
		})()

		try {
			await enabling
		} finally {
			enabling = null
		}
	}

	function bindListeners(): void {
		if (listenersBound) {
			return
		}

		listenerDisposers = [
			session.onEvent('Debugger.scriptParsed', (params, meta) => {
				handleScriptParsed(params as DebuggerScriptParsedParams, meta)
			}),
			session.onEvent('CSS.styleSheetAdded', (params, meta) => {
				handleStyleSheetAdded(params as CssStyleSheetAddedParams, meta)
			}),
			session.onEvent('CSS.styleSheetRemoved', (params, meta) => {
				handleStyleSheetRemoved(params as CssStyleSheetRemovedParams, meta)
			}),
		]
		listenersBound = true
	}

	function unbindListeners(): void {
		for (const dispose of listenerDisposers) {
			dispose()
		}
		listenerDisposers = []
		listenersBound = false
	}

	function getResources(): RuntimeResource[] {
		return [...scripts.values(), ...stylesheets.values()].sort((a, b) => a.url.localeCompare(b.url))
	}

	function getResource(url: string): RuntimeResource {
		const resource = scripts.get(url) ?? stylesheets.get(url)
		if (!resource) {
			throw new Error(`Resource not found: ${url}`)
		}
		return resource
	}

	async function getSource(resource: RuntimeResource): Promise<string> {
		const cacheKey = getSourceCacheKey(resource)
		const cached = sources.get(cacheKey)
		if (cached != null) {
			return cached
		}

		const source = resource.type === 'stylesheet' ? await readStylesheetSource(resource) : await readScriptSource(resource)
		sources.set(cacheKey, source)
		return source
	}

	async function getSourceForGrep(resource: RuntimeResource, skippedResources: CodeGrepSkippedResource[]): Promise<string | null> {
		try {
			return await getSource(resource)
		} catch (error) {
			// Only stale per-resource handles are downgraded to warnings. Transport/session failures should still abort the command.
			const reason = getStaleResourceReason(resource, error)
			if (!reason) {
				throw error
			}

			removeResource(resource)
			skippedResources.push({
				url: resource.url,
				type: resource.type,
				reason,
			})
			return null
		}
	}

	function registerResource(
		store: Map<string, RuntimeResource>,
		input: {
			type: CodeResourceType
			url: string | undefined
			id: string
			inlinePrefix: string
			sessionId: string | null
		},
	): void {
		const baseUrl = normalizeResourceUrl(input.url, input.inlinePrefix, input.id)
		if (!baseUrl) {
			return
		}

		const resource: RuntimeResource = {
			type: input.type,
			url: buildResourceHandle(baseUrl, input.id, input.sessionId),
			id: input.id,
			sessionId: input.sessionId,
		}

		store.set(resource.url, resource)
		sources.delete(getSourceCacheKey(resource))
		touchResources()
	}

	function removeResource(resource: RuntimeResource): void {
		const store = resource.type === 'stylesheet' ? stylesheets : scripts
		store.delete(resource.url)
		sources.delete(getSourceCacheKey(resource))
	}

	function removeResourceById(store: Map<string, RuntimeResource>, id: string, sessionId: string | null): void {
		for (const resource of store.values()) {
			if (resource.id !== id || resource.sessionId !== sessionId) {
				continue
			}

			removeResource(resource)
		}
	}

	/** Resolve once {@link QUIET_PERIOD_MS} passes with no resource event. See the lifecycle note above. */
	function waitForResourceQuietPeriod(): Promise<void> {
		return new Promise((resolve) => {
			settleResolvers.add(resolve)
			touchResources()
		})
	}

	/** Restart the quiet-period timer. Called by every resource event, so the window slides. */
	function touchResources(): void {
		if (settleTimer) {
			clearTimeout(settleTimer)
		}
		settleTimer = setTimeout(() => {
			settleTimer = null
			for (const resolve of settleResolvers) {
				resolve()
			}
			settleResolvers.clear()
		}, QUIET_PERIOD_MS)
	}

	/** Drop the inventory and release anyone mid-`ensureEnabled`, so a navigation cannot strand a wait. */
	function resetState(): void {
		clearResourceState()
		if (settleTimer) {
			clearTimeout(settleTimer)
			settleTimer = null
		}
		for (const resolve of settleResolvers) {
			resolve()
		}
		settleResolvers.clear()
	}

	function clearResourceState(): void {
		scripts.clear()
		stylesheets.clear()
		sources.clear()
	}

	async function readStylesheetSource(resource: RuntimeResource): Promise<string> {
		const result = await session.sendAndWait('CSS.getStyleSheetText', { styleSheetId: resource.id }, getSessionOptions(resource))
		return result.text ?? ''
	}

	async function readScriptSource(resource: RuntimeResource): Promise<string> {
		const result = await session.sendAndWait('Debugger.getScriptSource', { scriptId: resource.id }, getSessionOptions(resource))
		return result.scriptSource ?? ''
	}
}

const toCodeResource = (resource: RuntimeResource): CodeResource => ({
	url: resource.url,
	type: resource.type,
})

const normalizeResourceUrl = (url: string | undefined, inlinePrefix: string, fallbackId: string): string | null => {
	if (!url) {
		return `${inlinePrefix}${fallbackId}`
	}
	if (url.startsWith('chrome://') || url.startsWith('devtools://')) {
		return null
	}
	return url
}

const normalizeSearchPattern = (pattern: string | undefined): string | null => {
	const trimmed = pattern?.trim()
	return trimmed ? trimmed.toLowerCase() : null
}

const matchesUrlPattern = (resource: RuntimeResource, pattern: string | null): boolean => !pattern || resource.url.toLowerCase().includes(pattern)

const matchesLine = (line: string, pattern: ReturnType<typeof parseTextPattern>): boolean => matchesTextPattern(line, pattern)

const getSessionOptions = (resource: RuntimeResource): { sessionId?: string } | undefined =>
	resource.sessionId ? { sessionId: resource.sessionId } : undefined

const getSourceCacheKey = (resource: RuntimeResource): string => `${resource.type}:${resource.sessionId ?? 'root'}:${resource.id}`

async function editScript(session: CdpSessionHandle, resource: RuntimeResource, source: string): Promise<void> {
	let result: CdpResult<'Debugger.setScriptSource'>
	try {
		result = await session.sendAndWait('Debugger.setScriptSource', { scriptId: resource.id, scriptSource: source }, getSessionOptions(resource))
	} catch (error) {
		const message = formatError(error)
		if (/setScriptSource.*no longer available/i.test(message)) {
			throw new Error(
				'Live JS editing is not supported in Chrome 145+. Use `argus eval` to modify runtime state, or `argus code edit` on stylesheets.',
			)
		}
		throw error
	}
	assertScriptEditAccepted(result)
}

/** Throw a descriptive error when V8 rejects a live script edit. */
const assertScriptEditAccepted = (result: CdpResult<'Debugger.setScriptSource'>): void => {
	const status = result.status ?? 'Ok'
	if (status === 'Ok') {
		return
	}

	if (status === 'CompileError') {
		const detail = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'unknown compile error'
		throw new Error(`Script edit rejected (CompileError): ${detail}`)
	}

	const STATUS_LABELS: Record<string, string> = {
		BlockedByActiveGenerator: 'a generator function is currently suspended on the call stack',
		BlockedByActiveFunction: 'the edited function is currently on the call stack',
		BlockedByTopLevelEsModuleChange: 'top-level changes to ES modules are not supported',
	}
	const reason = STATUS_LABELS[status] ?? status
	throw new Error(`Script edit rejected: ${reason}`)
}

const getStaleResourceReason = (resource: RuntimeResource, error: unknown): string | null => {
	const message = formatError(error)
	if (resource.type === 'stylesheet' && /No style sheet with given id found/i.test(message)) {
		return message
	}

	return null
}

const buildResourceHandle = (url: string, id: string, sessionId: string | null): string => {
	if (url.startsWith(INLINE_SCRIPT_PREFIX) || url.startsWith(INLINE_STYLESHEET_PREFIX)) {
		return url
	}

	const suffix = sessionId ? `${sessionId}-${id}` : id
	return `${url}#argus-resource=${suffix}`
}
