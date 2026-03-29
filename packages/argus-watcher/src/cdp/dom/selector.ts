import type { CdpNode } from './types.js'
import type { CdpSessionHandle, CdpTargetContext } from '../connection.js'
import { filterNodesByText } from '../text-filter.js'

// ─────────────────────────────────────────────────────────────────────────────
// CDP response types (local to selector resolution)
// ─────────────────────────────────────────────────────────────────────────────

type CdpDocumentResult = {
	root?: { nodeId?: number }
}

type CdpQueryAllResult = {
	nodeIds?: number[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Selector resolution
// ─────────────────────────────────────────────────────────────────────────────

export type SelectorMatchResult = {
	/** All matched node IDs. */
	allNodeIds: number[]
	/** Node IDs to process (respects `all` flag). */
	nodeIds: number[]
}

export type ResolveSelectorTargetOptions = {
	selector: string
	all: boolean
	text?: string
	waitMs?: number
}

export const getDomRootId = async (session: CdpSessionHandle): Promise<number> => {
	const targetContext = session.getTargetContext?.()
	if (targetContext?.kind === 'frame') {
		return getFrameDomRootId(session, targetContext)
	}

	return getDocumentRootId(session)
}

export const resolveSelectorMatches = async (
	session: CdpSessionHandle,
	rootId: number,
	selector: string,
	all: boolean,
	text?: string,
): Promise<SelectorMatchResult> => {
	// Always use querySelectorAll to get the true match count
	const result = (await session.sendAndWait('DOM.querySelectorAll', { nodeId: rootId, selector })) as CdpQueryAllResult
	let allNodeIds = result.nodeIds ?? []

	if (text != null) {
		allNodeIds = await filterNodesByText(session, allNodeIds, text)
	}

	// If all=false, only return the first match (if any)
	const nodeIds = all ? allNodeIds : allNodeIds.slice(0, 1)

	return { allNodeIds, nodeIds }
}

/**
 * Poll for selector matches until at least one is found or the deadline is reached.
 * Returns the last resolution result (which may have zero matches on timeout).
 */
export const waitForSelectorMatches = async (
	session: CdpSessionHandle,
	selector: string,
	all: boolean,
	text: string | undefined,
	waitMs: number,
	intervalMs = 100,
): Promise<SelectorMatchResult> => {
	const deadline = Date.now() + waitMs
	while (true) {
		const rootId = await getDomRootId(session)
		const result = await resolveSelectorMatches(session, rootId, selector, all, text)
		if (result.allNodeIds.length > 0) return result
		const remaining = deadline - Date.now()
		if (remaining <= 0) return result
		await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)))
	}
}

/**
 * Enable the DOM domain, then resolve selector matches immediately or by polling for a bounded wait.
 */
export const resolveSelectorTargets = async (session: CdpSessionHandle, options: ResolveSelectorTargetOptions): Promise<SelectorMatchResult> => {
	await session.sendAndWait('DOM.enable')

	const waitMs = options.waitMs ?? 0
	if (waitMs > 0) {
		return waitForSelectorMatches(session, options.selector, options.all, options.text, waitMs)
	}

	const rootId = await getDomRootId(session)
	return resolveSelectorMatches(session, rootId, options.selector, options.all, options.text)
}

/** Resolve the first node id matching a selector, or null when no match exists. */
export const resolveFirstSelectorNodeId = async (session: CdpSessionHandle, selector: string, text?: string): Promise<number | null> => {
	const { nodeIds } = await resolveSelectorTargets(session, {
		selector,
		all: false,
		text,
	})

	return nodeIds[0] ?? null
}

/**
 * Frame-scoped DOM commands are most reliable when they stay inside the frame's child CDP session.
 * Extension mode already tracks that session id on the active target context, so prefer the normal
 * DOM root lookup in that routed session and only fall back to the older Runtime/DOM bridge when a
 * child session is not available.
 */
const getFrameDomRootId = async (session: CdpSessionHandle, targetContext: Extract<CdpTargetContext, { kind: 'frame' }>): Promise<number> => {
	if (targetContext.sessionId) {
		return getDocumentRootId(session)
	}

	if (targetContext.executionContextId == null) {
		throw new Error(`Selected frame is not ready yet: ${targetContext.frameId}`)
	}

	const evaluated = (await session.sendAndWait('Runtime.evaluate', {
		expression: 'document',
		contextId: targetContext.executionContextId,
		returnByValue: false,
	})) as { result?: { objectId?: string } }

	const objectId = evaluated.result?.objectId
	if (!objectId) {
		throw new Error(`Unable to resolve DOM root for frame: ${targetContext.frameId}`)
	}

	const requested = (await session.sendAndWait('DOM.requestNode', { objectId })) as { nodeId?: number }
	if (!requested.nodeId) {
		throw new Error(`Unable to resolve DOM root for frame: ${targetContext.frameId}`)
	}

	return requested.nodeId
}

const getDocumentRootId = async (session: CdpSessionHandle): Promise<number> => {
	const result = (await session.sendAndWait('DOM.getDocument', { depth: 1 })) as CdpDocumentResult
	const rootId = result.root?.nodeId
	if (!rootId) {
		throw new Error('Unable to resolve DOM root')
	}
	return rootId
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

export const toAttributesRecord = (attributes?: string[]): Record<string, string> => {
	if (!attributes || attributes.length === 0) {
		return {}
	}

	const record: Record<string, string> = {}
	for (let i = 0; i < attributes.length; i += 2) {
		const key = attributes[i]
		const value = attributes[i + 1] ?? ''
		if (key) {
			record[key] = value
		}
	}
	return record
}

export const countElementChildren = (children?: CdpNode[]): number => {
	if (!children) {
		return 0
	}
	return children.filter((c) => c.nodeType === 1).length
}

export const clamp = (value: number, min: number, max: number): number => {
	return Math.max(min, Math.min(max, value))
}
