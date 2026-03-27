import {
	matchesTextPattern,
	parseTextPattern,
	type CodeGrepMatch,
	type CodeGrepResponse,
	type CodeListResponse,
	type CodeReadResponse,
	type CodeResource,
	type CodeResourceType,
} from '@vforsh/argus-core'
import type { CdpEventMeta, CdpSessionHandle } from './connection.js'

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

type DebuggerGetScriptSourceResult = {
	scriptSource?: string
}

type CssGetStyleSheetTextResult = {
	text?: string
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
	reset: () => void
	rebind: () => void
}

/**
 * Runtime JS/CSS inspector backed by CDP Debugger + CSS domains.
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

		grep: async ({ pattern, urlPattern }) => {
			await ensureEnabled()
			const parsedPattern = parseTextPattern(pattern)
			const normalizedUrlPattern = normalizeSearchPattern(urlPattern)
			const matches: CodeGrepMatch[] = []

			for (const resource of getResources()) {
				if (!matchesUrlPattern(resource, normalizedUrlPattern)) {
					continue
				}

				const source = await getSource(resource)
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
						return { ok: true, matches }
					}
				}
			}

			return { ok: true, matches }
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

	function waitForResourceQuietPeriod(): Promise<void> {
		return new Promise((resolve) => {
			settleResolvers.add(resolve)
			touchResources()
		})
	}

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
		const result = (await session.sendAndWait(
			'CSS.getStyleSheetText',
			{ styleSheetId: resource.id },
			getSessionOptions(resource),
		)) as CssGetStyleSheetTextResult
		return result.text ?? ''
	}

	async function readScriptSource(resource: RuntimeResource): Promise<string> {
		const result = (await session.sendAndWait(
			'Debugger.getScriptSource',
			{ scriptId: resource.id },
			getSessionOptions(resource),
		)) as DebuggerGetScriptSourceResult
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

const buildResourceHandle = (url: string, id: string, sessionId: string | null): string => {
	if (url.startsWith(INLINE_SCRIPT_PREFIX) || url.startsWith(INLINE_STYLESHEET_PREFIX)) {
		return url
	}

	const suffix = sessionId ? `${sessionId}-${id}` : id
	return `${url}#argus-resource=${suffix}`
}
