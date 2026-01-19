import type { DomNode, DomElementInfo, DomTreeResponse, DomInfoResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DEPTH = 2
const DEFAULT_MAX_NODES = 5000
const DEFAULT_OUTER_HTML_MAX_CHARS = 50_000

const MAX_DEPTH = 10
const MAX_MAX_NODES = 50_000
const MAX_OUTER_HTML_CHARS = 500_000

// ─────────────────────────────────────────────────────────────────────────────
// CDP response types (internal)
// ─────────────────────────────────────────────────────────────────────────────

type CdpNode = {
	nodeId: number
	nodeType: number
	nodeName: string
	localName?: string
	attributes?: string[]
	children?: CdpNode[]
	childNodeCount?: number
}

type CdpDocumentResult = {
	root?: { nodeId?: number }
}

type CdpQueryAllResult = {
	nodeIds?: number[]
}

type CdpDescribeResult = {
	node?: CdpNode
}

type CdpOuterHtmlResult = {
	outerHTML?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Options types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for fetching a DOM subtree by selector. */
export type FetchDomTreeOptions = {
	selector: string
	depth?: number
	maxNodes?: number
	all?: boolean
}

/** Options for fetching DOM element info by selector. */
export type FetchDomInfoOptions = {
	selector: string
	all?: boolean
	outerHtmlMaxChars?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

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
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, all)

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

/**
 * Fetch detailed info for element(s) matching a CSS selector.
 */
export const fetchDomInfoBySelector = async (session: CdpSessionHandle, options: FetchDomInfoOptions): Promise<DomInfoResponse> => {
	const all = options.all ?? false
	const maxChars = clamp(options.outerHtmlMaxChars ?? DEFAULT_OUTER_HTML_MAX_CHARS, 0, MAX_OUTER_HTML_CHARS)

	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, all)

	if (allNodeIds.length === 0) {
		return { ok: true, matches: 0, elements: [] }
	}

	const elements: DomElementInfo[] = []

	for (const nodeId of nodeIds) {
		const describeResult = (await session.sendAndWait('DOM.describeNode', {
			nodeId,
			depth: 1, // Just enough to get child count
		})) as CdpDescribeResult

		if (!describeResult.node) {
			continue
		}

		const node = describeResult.node
		const attributes = toAttributesRecord(node.attributes)
		const childElementCount = countElementChildren(node.children)

		let outerHTML: string | null = null
		let outerHTMLTruncated = false

		try {
			const htmlResult = (await session.sendAndWait('DOM.getOuterHTML', { nodeId })) as CdpOuterHtmlResult
			outerHTML = htmlResult.outerHTML ?? null

			if (outerHTML && outerHTML.length > maxChars) {
				outerHTML = outerHTML.slice(0, maxChars)
				outerHTMLTruncated = true
			}
		} catch {
			// getOuterHTML can fail for certain nodes; leave as null
		}

		elements.push({
			nodeId,
			tag: (node.localName ?? node.nodeName).toLowerCase(),
			attributes,
			childElementCount,
			outerHTML,
			outerHTMLTruncated,
		})
	}

	return { ok: true, matches: allNodeIds.length, elements }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const getDomRootId = async (session: CdpSessionHandle): Promise<number> => {
	const result = (await session.sendAndWait('DOM.getDocument', { depth: 1 })) as CdpDocumentResult
	const rootId = result.root?.nodeId
	if (!rootId) {
		throw new Error('Unable to resolve DOM root')
	}
	return rootId
}

type SelectorMatchResult = {
	/** All matched node IDs. */
	allNodeIds: number[]
	/** Node IDs to process (respects `all` flag). */
	nodeIds: number[]
}

const resolveSelectorMatches = async (session: CdpSessionHandle, rootId: number, selector: string, all: boolean): Promise<SelectorMatchResult> => {
	// Always use querySelectorAll to get the true match count
	const result = (await session.sendAndWait('DOM.querySelectorAll', { nodeId: rootId, selector })) as CdpQueryAllResult
	const allNodeIds = result.nodeIds ?? []

	// If all=false, only return the first match (if any)
	const nodeIds = all ? allNodeIds : allNodeIds.slice(0, 1)

	return { allNodeIds, nodeIds }
}

const toAttributesRecord = (attributes?: string[]): Record<string, string> => {
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

const countElementChildren = (children?: CdpNode[]): number => {
	if (!children) {
		return 0
	}
	return children.filter((c) => c.nodeType === 1).length
}

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

const clamp = (value: number, min: number, max: number): number => {
	return Math.max(min, Math.min(max, value))
}
