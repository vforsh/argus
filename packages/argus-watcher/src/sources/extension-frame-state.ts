import type { CdpSourceTarget } from './types.js'

type SessionSummary = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
}

export type ExtensionFrameState = {
	topFrameId: string | null
	requestedFrameId: string | null
	requestedFrameHint: RequestedFrameHint | null
	/** True once an active iframe disappears and we should report the page while waiting to rematch it safely. */
	requestedFrameDetached: boolean
	activeFrameId: string | null
	activeAttachedAt: number | null
	frames: Map<string, ExtensionFrame>
	executionContexts: Map<string, number>
	pendingTitleLoads: Set<string>
}

export type ExtensionFrame = {
	frameId: string
	parentFrameId: string | null
	url: string
	title: string | null
	sessionId: string | null
}

export type RequestedFrameHint = {
	/**
	 * Exact iframe URL at the moment the user selected it.
	 * Prefer an exact match first, then fall back to a normalized URL key when the reload only
	 * changes query/hash noise. Both paths still fail closed unless the match is unique.
	 */
	url: string | null
	urlKey: string | null
	title: string | null
}

export type RequestedTargetResolution = { kind: 'page' } | { kind: 'pending' } | { kind: 'frame'; frameId: string }

export type CdpFrameTreeNode = {
	frame?: {
		id?: string
		parentId?: string
		url?: string
		name?: string
	}
	childFrames?: CdpFrameTreeNode[]
}

export const createEmptyFrameState = (): ExtensionFrameState => ({
	topFrameId: null,
	requestedFrameId: null,
	requestedFrameHint: null,
	requestedFrameDetached: false,
	activeFrameId: null,
	activeAttachedAt: null,
	frames: new Map(),
	executionContexts: new Map(),
	pendingTitleLoads: new Set(),
})

export const createNotAttachedError = (): Error => {
	const error = new Error('No tab attached via extension')
	;(error as Error & { code?: string }).code = 'cdp_not_attached'
	return error
}

export const formatPageTargetId = (tabId: number): string => `tab:${tabId}`

export const formatFrameTargetId = (tabId: number, frameId: string): string => `frame:${tabId}:${frameId}`

export const parseExtensionTargetId = (targetId: string): { tabId: number; frameId: string | null } => {
	if (targetId.startsWith('tab:')) {
		const tabId = Number.parseInt(targetId.slice(4), 10)
		if (Number.isFinite(tabId)) {
			return { tabId, frameId: null }
		}
	}

	if (targetId.startsWith('frame:')) {
		const [, tabIdRaw, ...frameIdParts] = targetId.split(':')
		const tabId = Number.parseInt(tabIdRaw ?? '', 10)
		const frameId = frameIdParts.join(':')
		if (Number.isFinite(tabId) && frameId) {
			return { tabId, frameId }
		}
	}

	const legacyTabId = Number.parseInt(targetId, 10)
	if (Number.isFinite(legacyTabId)) {
		return { tabId: legacyTabId, frameId: null }
	}

	throw new Error(`Invalid extension target id: ${targetId}`)
}

export const buildPageTarget = (session: SessionSummary, options: { attached: boolean }): CdpSourceTarget => ({
	id: formatPageTargetId(session.tabId),
	title: session.title,
	url: session.url,
	type: 'page',
	parentId: null,
	faviconUrl: session.faviconUrl,
	attached: options.attached,
})

export const frameToTarget = (
	tabId: number,
	frame: ExtensionFrame,
	options: { attached: boolean; faviconUrl?: string; topFrameId: string | null },
): CdpSourceTarget => ({
	id: formatFrameTargetId(tabId, frame.frameId),
	title: frame.title ?? frame.url ?? `iframe ${frame.frameId}`,
	url: frame.url,
	type: 'iframe',
	parentId:
		frame.parentFrameId && frame.parentFrameId !== options.topFrameId
			? formatFrameTargetId(tabId, frame.parentFrameId)
			: formatPageTargetId(tabId),
	faviconUrl: options.faviconUrl,
	attached: options.attached,
})

export const buildFrameTargets = (state: ExtensionFrameState, tabId: number, activeFrameId: string | null, faviconUrl?: string): CdpSourceTarget[] =>
	[...state.frames.values()]
		.filter((frame) => frame.frameId !== state.topFrameId)
		.map((frame) => frameToTarget(tabId, frame, { attached: frame.frameId === activeFrameId, faviconUrl, topFrameId: state.topFrameId }))

export const collectFrameTree = (node: CdpFrameTreeNode | undefined, state: ExtensionFrameState): void => {
	if (!node?.frame?.id) {
		return
	}

	const frameId = node.frame.id
	state.frames.set(frameId, {
		frameId,
		parentFrameId: node.frame.parentId ?? null,
		url: node.frame.url ?? '',
		title: node.frame.name ?? null,
		sessionId: state.frames.get(frameId)?.sessionId ?? null,
	})
	if (!node.frame.parentId) {
		state.topFrameId = frameId
	}

	for (const child of node.childFrames ?? []) {
		collectFrameTree(child, state)
	}
}

export const parseFrame = (params: unknown): ExtensionFrame | null => {
	const record = params as { frame?: { id?: string; parentId?: string | null; url?: string; name?: string } }
	const frameId = record.frame?.id
	const url = record.frame?.url
	if (!frameId || !url || typeof url !== 'string' || url.trim() === '') {
		return null
	}
	return {
		frameId,
		parentFrameId: record.frame?.parentId ?? null,
		url,
		title: record.frame?.name ?? null,
		sessionId: null,
	}
}

export const parseExecutionContext = (params: unknown): { id: number; frameId: string | null; isDefault: boolean } | null => {
	const record = params as {
		context?: {
			id?: number
			auxData?: { frameId?: string; isDefault?: boolean }
		}
	}
	if (record.context?.id == null) {
		return null
	}

	return {
		id: record.context.id,
		frameId: record.context.auxData?.frameId ?? null,
		isDefault: record.context.auxData?.isDefault === true,
	}
}

export const createRequestedFrameHint = (frame: ExtensionFrame | null | undefined): RequestedFrameHint | null => {
	if (!frame) {
		return null
	}

	return {
		url: frame.url || null,
		urlKey: normalizeFrameUrlKey(frame.url),
		title: frame.title?.trim() || null,
	}
}

/**
 * Selection is about the user's intended target, not whether every frame-scoped command is ready.
 * Once the watcher knows the frame exists we can switch the active target; commands that require
 * an execution context still guard that separately at execution time.
 */
export const resolveRequestedFrameId = (
	state: ExtensionFrameState,
	requestedFrameId: string | null,
	requestedFrameHint: RequestedFrameHint | null,
): string | null => {
	if (!requestedFrameId) {
		return null
	}

	if (state.frames.has(requestedFrameId)) {
		return requestedFrameId
	}

	if (!requestedFrameHint) {
		return null
	}

	return findRequestedFrameMatch(state, requestedFrameHint)
}

/**
 * Pending iframe selections have two valid states:
 * - `pending`: the iframe has never become active in this attachment yet, so keep waiting silently.
 * - `page`: the iframe was active and then disappeared, so report the page while we wait for a safe rematch.
 */
export const resolveRequestedTarget = (state: ExtensionFrameState): RequestedTargetResolution => {
	if (state.requestedFrameId == null) {
		return { kind: 'page' }
	}

	const nextFrameId = resolveRequestedFrameId(state, state.requestedFrameId, state.requestedFrameHint)
	if (nextFrameId) {
		return { kind: 'frame', frameId: nextFrameId }
	}

	return state.requestedFrameDetached ? { kind: 'page' } : { kind: 'pending' }
}

const findSingleMatchingFrameId = (state: ExtensionFrameState, predicate: (frame: ExtensionFrame) => boolean): string | null => {
	let matchId: string | null = null
	for (const frame of state.frames.values()) {
		if (!predicate(frame)) {
			continue
		}
		if (matchId) {
			return null
		}
		matchId = frame.frameId
	}
	return matchId
}

const findRequestedFrameMatch = (state: ExtensionFrameState, requestedFrameHint: RequestedFrameHint): string | null => {
	const exactUrlMatch = findFrameMatchByUrl(state, requestedFrameHint.url)
	if (exactUrlMatch) {
		return exactUrlMatch
	}

	const normalizedUrlMatch = findFrameMatchByNormalizedUrl(state, requestedFrameHint.urlKey)
	if (normalizedUrlMatch) {
		return normalizedUrlMatch
	}

	if (requestedFrameHint.url != null || !requestedFrameHint.title) {
		return null
	}

	return findSingleMatchingFrameId(state, (frame) => frame.title?.trim() === requestedFrameHint.title)
}

const findFrameMatchByUrl = (state: ExtensionFrameState, url: string | null): string | null => {
	if (url == null) {
		return null
	}

	return findSingleMatchingFrameId(state, (frame) => frame.url === url)
}

const findFrameMatchByNormalizedUrl = (state: ExtensionFrameState, urlKey: string | null): string | null => {
	if (urlKey == null) {
		return null
	}

	return findSingleMatchingFrameId(state, (frame) => normalizeFrameUrlKey(frame.url) === urlKey)
}

const normalizeFrameUrlKey = (url: string | null | undefined): string | null => {
	if (!url || url.trim() === '') {
		return null
	}

	try {
		const parsed = new URL(url)
		return `${parsed.origin}${parsed.pathname || '/'}`
	} catch {
		return url.split(/[?#]/, 1)[0] || null
	}
}
