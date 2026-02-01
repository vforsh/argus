import type { CdpNode } from './types.js'
import type { CdpSessionHandle } from '../connection.js'
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

export const getDomRootId = async (session: CdpSessionHandle): Promise<number> => {
	const result = (await session.sendAndWait('DOM.getDocument', { depth: 1 })) as CdpDocumentResult
	const rootId = result.root?.nodeId
	if (!rootId) {
		throw new Error('Unable to resolve DOM root')
	}
	return rootId
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
