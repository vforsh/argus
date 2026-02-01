import type { DomNode, DomTreeResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../connection.js'
import type { CdpNode, CdpDescribeResult } from './types.js'
import { getDomRootId, resolveSelectorMatches, toAttributesRecord, clamp } from './selector.js'

const DEFAULT_DEPTH = 2
const DEFAULT_MAX_NODES = 5000

const MAX_DEPTH = 10
const MAX_MAX_NODES = 50_000

/** Options for fetching a DOM subtree by selector. */
export type FetchDomTreeOptions = {
	selector: string
	depth?: number
	maxNodes?: number
	all?: boolean
	text?: string
}

/**
 * Fetch a DOM subtree rooted at element(s) matching a CSS selector.
 * Returns only element nodes (nodeType === 1).
 */
export const fetchDomSubtreeBySelector = async (session: CdpSessionHandle, options: FetchDomTreeOptions): Promise<DomTreeResponse> => {
	const depth = clamp(options.depth ?? DEFAULT_DEPTH, 0, MAX_DEPTH)
	const maxNodes = clamp(options.maxNodes ?? DEFAULT_MAX_NODES, 1, MAX_MAX_NODES)
	const all = options.all ?? false

	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, all, options.text)

	if (allNodeIds.length === 0) {
		return { ok: true, matches: 0, roots: [], truncated: false }
	}

	const state: TraversalState = { count: 0, maxNodes, truncated: false, truncatedReason: undefined }
	const roots: DomNode[] = []

	for (const nodeId of nodeIds) {
		if (state.count >= maxNodes) {
			state.truncated = true
			state.truncatedReason = 'max_nodes'
			break
		}

		const describeResult = (await session.sendAndWait('DOM.describeNode', {
			nodeId,
			depth: depth + 1, // CDP depth is from the queried node, so +1 to include that node
		})) as CdpDescribeResult

		if (!describeResult.node) {
			continue
		}

		const tree = toDomNodeTree(describeResult.node, depth, state)
		if (tree) {
			roots.push(tree)
		}
	}

	return {
		ok: true,
		matches: allNodeIds.length,
		roots,
		truncated: state.truncated,
		truncatedReason: state.truncatedReason,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Traversal
// ─────────────────────────────────────────────────────────────────────────────

type TraversalState = {
	count: number
	maxNodes: number
	truncated: boolean
	truncatedReason?: 'max_nodes' | 'depth'
}

const toDomNodeTree = (node: CdpNode, remainingDepth: number, state: TraversalState): DomNode | null => {
	// Filter to element nodes only
	if (node.nodeType !== 1) {
		return null
	}

	state.count++

	const result: DomNode = {
		nodeId: node.nodeId,
		tag: (node.localName ?? node.nodeName).toLowerCase(),
		attributes: toAttributesRecord(node.attributes),
	}

	// Check if we should descend further
	if (remainingDepth <= 0) {
		if (node.children && node.children.some((c) => c.nodeType === 1)) {
			result.truncated = true
			state.truncated = true
			if (!state.truncatedReason) {
				state.truncatedReason = 'depth'
			}
		}
		return result
	}

	// Check maxNodes limit
	if (state.count >= state.maxNodes) {
		if (node.children && node.children.some((c) => c.nodeType === 1)) {
			result.truncated = true
			state.truncated = true
			state.truncatedReason = 'max_nodes'
		}
		return result
	}

	// Process children
	if (node.children && node.children.length > 0) {
		const children: DomNode[] = []
		for (const child of node.children) {
			if (state.count >= state.maxNodes) {
				result.truncated = true
				state.truncated = true
				state.truncatedReason = 'max_nodes'
				break
			}

			const childNode = toDomNodeTree(child, remainingDepth - 1, state)
			if (childNode) {
				children.push(childNode)
			}
		}
		if (children.length > 0) {
			result.children = children
		}
	}

	return result
}
