import type { ExtensionIframeMatch } from '@vforsh/argus-core'
import type { CdpSourceTarget } from './types.js'
import type { CdpTargetContext } from '../cdp/connection.js'
import { normalizeNetUrlKey } from '../net/filtering.js'

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
	activeFrameId: string | null
	activeAttachedAt: number | null
	frames: Map<string, ExtensionFrame>
	executionContexts: Map<string, number>
	pendingTitleLoads: Set<string>
	/** Epoch ms of the last real top-frame navigation (reload included); null before the first one. */
	lastTopNavigationAt: number | null
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
	/**
	 * The selector the user picked the iframe with (`--iframe-url`/`--iframe-title`). It names the
	 * intent, so it re-resolves first; the frame-derived fields above only break ties or cover a
	 * selection made without one (`--iframe auto`, the extension popup).
	 */
	match?: ExtensionIframeMatch
}

export type RequestedTargetResolution = { kind: 'page' } | { kind: 'pending' } | { kind: 'frame'; frameId: string }
export type SelectedFrameCommandState =
	| { kind: 'page' }
	| { kind: 'pending'; frameId: string | null; reason: 'frame_missing' | 'frame_not_ready' }
	| { kind: 'frame'; frameId: string; sessionId: string | null; executionContextId: number | null }

export const createEmptyFrameState = (): ExtensionFrameState => ({
	topFrameId: null,
	requestedFrameId: null,
	requestedFrameHint: null,
	activeFrameId: null,
	activeAttachedAt: null,
	frames: new Map(),
	executionContexts: new Map(),
	pendingTitleLoads: new Set(),
	lastTopNavigationAt: null,
})

export { createNotAttachedError } from '../errors.js'

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

export const createRequestedFrameHint = (frame: ExtensionFrame | null | undefined, match?: ExtensionIframeMatch): RequestedFrameHint | null => {
	if (!frame) {
		return match ? { url: null, urlKey: null, title: null, match } : null
	}

	return {
		url: frame.url || null,
		urlKey: normalizeNetUrlKey(frame.url),
		title: frame.title?.trim() || null,
		...(match ? { match } : {}),
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
 * A requested iframe stays pending while missing, including after detach. Only an explicit
 * page selection may resolve to the page; losing a frame must never change command scope.
 */
export const resolveRequestedTarget = (state: ExtensionFrameState): RequestedTargetResolution => {
	if (state.requestedFrameId == null) {
		return { kind: 'page' }
	}

	const nextFrameId = resolveRequestedFrameId(state, state.requestedFrameId, state.requestedFrameHint)
	if (nextFrameId) {
		return { kind: 'frame', frameId: nextFrameId }
	}

	return { kind: 'pending' }
}

/**
 * Selection stays sticky across reloads, but frame-scoped commands must not silently fall back to
 * the page while the requested iframe is still rematching or booting a fresh execution context.
 */
export const resolveSelectedFrameCommandState = (state: ExtensionFrameState): SelectedFrameCommandState => {
	if (state.requestedFrameId == null) {
		return { kind: 'page' }
	}

	const resolution = resolveRequestedTarget(state)
	if (resolution.kind !== 'frame') {
		return {
			kind: 'pending',
			frameId: null,
			reason: 'frame_missing',
		}
	}

	const frame = state.frames.get(resolution.frameId)
	const sessionId = frame?.sessionId ?? null
	const executionContextId = state.executionContexts.get(resolution.frameId) ?? null
	if (sessionId == null && executionContextId == null) {
		return {
			kind: 'pending',
			frameId: resolution.frameId,
			reason: 'frame_not_ready',
		}
	}

	return {
		kind: 'frame',
		frameId: resolution.frameId,
		sessionId,
		executionContextId,
	}
}

export const isSelectedTargetReady = (state: ExtensionFrameState): boolean => resolveSelectedFrameCommandState(state).kind !== 'pending'

/** Build the frame-scoped CDP target context for a frame tracked in `state`. */
export const buildFrameTargetContext = (state: ExtensionFrameState, frameId: string): Extract<CdpTargetContext, { kind: 'frame' }> => ({
	kind: 'frame',
	frameId,
	executionContextId: state.executionContexts.get(frameId) ?? null,
	sessionId: state.frames.get(frameId)?.sessionId ?? null,
})

type FramePredicate = (frame: ExtensionFrame) => boolean

const findSingleMatchingFrameId = (state: ExtensionFrameState, predicate: FramePredicate): string | null => {
	let matchId: string | null = null
	for (const frame of state.frames.values()) {
		if (frame.frameId === state.topFrameId || !predicate(frame)) {
			continue
		}
		if (matchId) {
			return null
		}
		matchId = frame.frameId
	}
	return matchId
}

/**
 * Re-resolve a selection whose frame id is gone. The user's own selector goes first: a host page
 * that re-signs the iframe URL on every load defeats the exact URL, while the substring the user
 * chose survives. When it matches several frames, the frame-derived hint picks among
 * them; when it matches none, the hint alone decides. Every path stays unique-or-nothing.
 */
const findRequestedFrameMatch = (state: ExtensionFrameState, requestedFrameHint: RequestedFrameHint): string | null => {
	const { match } = requestedFrameHint
	if (!match) {
		return findHintFrameMatch(state, requestedFrameHint, () => true)
	}

	const matchesSelector: FramePredicate = (frame) => frameMatchesIframeSelector(frame, match)
	const selectorMatches = [...state.frames.values()].filter((frame) => frame.frameId !== state.topFrameId && matchesSelector(frame))
	if (selectorMatches.length === 1) {
		return selectorMatches[0]!.frameId
	}
	return findHintFrameMatch(state, requestedFrameHint, selectorMatches.length > 0 ? matchesSelector : () => true)
}

/** Same case-insensitive substring rule the CLI selected with, including its title-or-URL fallback. */
const frameMatchesIframeSelector = (frame: ExtensionFrame, match: ExtensionIframeMatch): boolean => {
	if (!frame.url) {
		return false
	}
	const haystack = match.by === 'url' ? frame.url : (frame.title ?? frame.url)
	return haystack.toLowerCase().includes(match.value.toLowerCase())
}

const findHintFrameMatch = (state: ExtensionFrameState, requestedFrameHint: RequestedFrameHint, within: FramePredicate): string | null => {
	const matchWithin = (predicate: FramePredicate) => findSingleMatchingFrameId(state, (frame) => within(frame) && predicate(frame))
	const { url, urlKey, title } = requestedFrameHint

	const exactUrlMatch = url == null ? null : matchWithin((frame) => frame.url === url)
	if (exactUrlMatch) {
		return exactUrlMatch
	}

	const normalizedUrlMatch = urlKey == null ? null : matchWithin((frame) => normalizeNetUrlKey(frame.url) === urlKey)
	if (normalizedUrlMatch) {
		return normalizedUrlMatch
	}

	if (url != null || !title) {
		return null
	}

	return matchWithin((frame) => frame.title?.trim() === title)
}
