import type { AXTreeNode, SnapshotResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

// ─────────────────────────────────────────────────────────────────────────────
// CDP response types (internal)
// ─────────────────────────────────────────────────────────────────────────────

type CdpAXValue = {
	type: string
	value?: unknown
}

type CdpAXProperty = {
	name: string
	value: CdpAXValue
}

type CdpAXNode = {
	nodeId: string
	parentId?: string
	childIds?: string[]
	ignored?: boolean
	role?: CdpAXValue
	name?: CdpAXValue
	value?: CdpAXValue
	properties?: CdpAXProperty[]
	backendDOMNodeId?: number
}

type CdpAXTreeResult = {
	nodes?: CdpAXNode[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export type FetchSnapshotOptions = {
	selector?: string
	depth?: number
	interactive?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
	'button',
	'checkbox',
	'combobox',
	'link',
	'listbox',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'radio',
	'searchbox',
	'slider',
	'spinbutton',
	'switch',
	'tab',
	'textbox',
	'treeitem',
])

/** Structural containers with no semantic meaning — flatten them away. */
const GENERIC_ROLES = new Set(['generic', 'none', 'presentation'])

/** Landmark and structural roles preserved as context in interactive mode. */
const LANDMARK_ROLES = new Set([
	'banner',
	'complementary',
	'contentinfo',
	'form',
	'main',
	'navigation',
	'region',
	'search',
	'dialog',
	'alertdialog',
	'heading',
	'group',
	'list',
	'toolbar',
	'menu',
	'menubar',
	'tablist',
	'tree',
	'treegrid',
	'grid',
	'table',
])

/** Properties worth surfacing in the output. */
const RELEVANT_PROPERTIES = new Set([
	'checked',
	'disabled',
	'expanded',
	'focused',
	'level',
	'required',
	'selected',
	'readonly',
	'pressed',
	'valuemin',
	'valuemax',
	'valuetext',
	'autocomplete',
	'multiselectable',
	'orientation',
])

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch an accessibility tree snapshot.
 *
 * 1. Enable Accessibility domain
 * 2. Optionally resolve a CSS selector to scope the tree
 * 3. Fetch the AX tree via CDP
 * 4. Reconstruct flat array into nested tree
 * 5. Apply filters (skip ignored, flatten generic, interactive-only, depth)
 */
export const fetchAccessibilitySnapshot = async (session: CdpSessionHandle, options: FetchSnapshotOptions): Promise<SnapshotResponse> => {
	await session.sendAndWait('Accessibility.enable')

	// Always fetch the full tree — getPartialAXTree with fetchRelatives:false
	// returns only a single node without descendants, which is not useful.
	const axResult = (await session.sendAndWait('Accessibility.getFullAXTree')) as CdpAXTreeResult
	let nodes = axResult.nodes ?? []

	// If a CSS selector is provided, scope to that DOM subtree.
	// Since the AX tree structure doesn't always mirror DOM containment
	// (e.g. forms without aria-label are invisible, their children parent up),
	// we collect all backendDOMNodeIds within the DOM subtree and filter AX nodes by those.
	if (options.selector) {
		// Use Runtime.evaluate to get all backendNodeIds in the subtree efficiently
		const resolveResult = (await session.sendAndWait('Runtime.evaluate', {
			expression: `document.querySelector(${JSON.stringify(options.selector)})`,
			returnByValue: false,
		})) as { result?: { objectId?: string; subtype?: string } }

		if (!resolveResult.result?.objectId || resolveResult.result.subtype === 'null') {
			throw new Error(`No element found for selector: ${options.selector}`)
		}

		// Enable DOM and load the document tree so requestNode/querySelectorAll work.
		await session.sendAndWait('DOM.enable')
		await session.sendAndWait('DOM.getDocument', { depth: -1 })

		const domNode = (await session.sendAndWait('DOM.requestNode', {
			objectId: resolveResult.result.objectId,
		})) as { nodeId?: number }
		if (!domNode.nodeId) {
			throw new Error('Unable to resolve DOM node')
		}

		const allDescendants = (await session.sendAndWait('DOM.querySelectorAll', {
			nodeId: domNode.nodeId,
			selector: '*',
		})) as { nodeIds?: number[] }
		const descendantNodeIds = allDescendants.nodeIds ?? []

		// Collect backendNodeIds for root + all descendants
		const backendIds = new Set<number>()
		const allDomNodeIds = [domNode.nodeId, ...descendantNodeIds]
		for (const nid of allDomNodeIds) {
			const desc = (await session.sendAndWait('DOM.describeNode', { nodeId: nid, depth: 0 })) as {
				node?: { backendNodeId?: number }
			}
			if (desc.node?.backendNodeId != null) {
				backendIds.add(desc.node.backendNodeId)
			}
		}

		// Filter AX nodes: keep those with matching backendDOMNodeId
		// Plus all their AX descendants (for text nodes etc. that don't have backendDOMNodeId)
		nodes = filterByDomSubtree(nodes, backendIds)
	}

	const totalNodes = nodes.length

	const roots = buildTree(nodes, {
		depth: options.depth,
		interactive: options.interactive ?? false,
	})

	const returnedNodes = countNodes(roots)

	return { ok: true as const, roots, totalNodes, returnedNodes }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree reconstruction
// ─────────────────────────────────────────────────────────────────────────────

type BuildTreeOptions = {
	depth?: number
	interactive: boolean
}

/**
 * Reconstruct the flat CDP AXNode array into a nested AXTreeNode tree.
 *
 * 1. Index all nodes by nodeId into a Map.
 * 2. Find root nodes (parentId absent or not in map).
 * 3. Recursively build tree with filtering.
 */
const buildTree = (cdpNodes: CdpAXNode[], options: BuildTreeOptions): AXTreeNode[] => {
	const nodeMap = new Map<string, CdpAXNode>()
	for (const node of cdpNodes) {
		nodeMap.set(node.nodeId, node)
	}

	const rootIds: string[] = []
	for (const node of cdpNodes) {
		if (!node.parentId || !nodeMap.has(node.parentId)) {
			rootIds.push(node.nodeId)
		}
	}

	const results: AXTreeNode[] = []
	for (const rootId of rootIds) {
		results.push(...convertNode(nodeMap, rootId, 0, options))
	}

	return results
}

/**
 * Convert a single CdpAXNode to AXTreeNode(s).
 * Returns an array because ignored/generic nodes get flattened (children become siblings).
 */
const convertNode = (nodeMap: Map<string, CdpAXNode>, nodeId: string, currentDepth: number, options: BuildTreeOptions): AXTreeNode[] => {
	const cdpNode = nodeMap.get(nodeId)
	if (!cdpNode) {
		return []
	}

	const role = extractStringValue(cdpNode.role) ?? 'unknown'
	const name = extractStringValue(cdpNode.name) ?? ''

	// Recurse into children first (needed for interactive filtering)
	const childIds = cdpNode.childIds ?? []
	const depthExceeded = options.depth != null && currentDepth >= options.depth
	const childResults: AXTreeNode[] = []

	if (!depthExceeded) {
		for (const childId of childIds) {
			childResults.push(...convertNode(nodeMap, childId, currentDepth + 1, options))
		}
	}

	// Skip ignored nodes — pass through children
	if (cdpNode.ignored) {
		return childResults
	}

	// Flatten generic container nodes with no name — pass through children
	if (GENERIC_ROLES.has(role) && !name) {
		return childResults
	}

	// Skip InlineTextBox nodes — Chrome rendering detail, always repeat parent StaticText
	if (role === 'InlineTextBox') {
		return []
	}

	// Build the output node
	const result: AXTreeNode = { role, name }

	const value = extractStringValue(cdpNode.value)
	if (value != null && value !== '') {
		result.value = value
	}

	const properties = extractProperties(cdpNode.properties)
	if (properties && Object.keys(properties).length > 0) {
		result.properties = properties
	}

	if (childResults.length > 0) {
		result.children = childResults
	}

	// Interactive-only filter: keep node if it is interactive or has interactive descendants
	if (options.interactive) {
		const isInteractive = INTERACTIVE_ROLES.has(role)
		const hasInteractiveDescendant = childResults.length > 0
		if (!isInteractive && !hasInteractiveDescendant) {
			return []
		}
		// Non-interactive node with interactive descendants — keep as context only if meaningful
		if (!isInteractive && !name && !LANDMARK_ROLES.has(role)) {
			return childResults
		}
	}

	return [result]
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const extractStringValue = (axValue?: CdpAXValue): string | undefined => {
	if (!axValue || axValue.value == null) {
		return undefined
	}
	return String(axValue.value)
}

const extractProperties = (properties?: CdpAXProperty[]): Record<string, string | number | boolean> | undefined => {
	if (!properties || properties.length === 0) {
		return undefined
	}

	const result: Record<string, string | number | boolean> = {}
	for (const prop of properties) {
		if (!RELEVANT_PROPERTIES.has(prop.name)) {
			continue
		}
		const val = prop.value?.value
		if (val == null) {
			continue
		}
		if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') {
			// Skip false/default values to reduce noise
			if (typeof val === 'boolean' && !val) {
				continue
			}
			result[prop.name] = val
		}
	}

	return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Filter AX nodes to those whose backendDOMNodeId is in the given set,
 * plus their AX children (which may not have backendDOMNodeId, e.g. StaticText).
 * Rewires parentId so the topmost matching nodes become roots.
 */
const filterByDomSubtree = (allNodes: CdpAXNode[], backendIds: Set<number>): CdpAXNode[] => {
	const nodeMap = new Map<string, CdpAXNode>()
	for (const node of allNodes) {
		nodeMap.set(node.nodeId, node)
	}

	// Start with AX nodes that directly match a DOM backendNodeId
	const matchedAxIds = new Set<string>()
	for (const node of allNodes) {
		if (node.backendDOMNodeId != null && backendIds.has(node.backendDOMNodeId)) {
			matchedAxIds.add(node.nodeId)
		}
	}

	// BFS: also include all AX descendants of matched nodes
	const finalIds = new Set<string>(matchedAxIds)
	const queue = [...matchedAxIds]
	while (queue.length > 0) {
		const id = queue.shift()!
		const node = nodeMap.get(id)
		if (node?.childIds) {
			for (const childId of node.childIds) {
				if (!finalIds.has(childId)) {
					finalIds.add(childId)
					queue.push(childId)
				}
			}
		}
	}

	// Filter and rewire: nodes whose parent is not in the set become roots
	return allNodes
		.filter((n) => finalIds.has(n.nodeId))
		.map((n) => {
			if (n.parentId && !finalIds.has(n.parentId)) {
				return { ...n, parentId: undefined }
			}
			return n
		})
}

const countNodes = (nodes: AXTreeNode[]): number => {
	let count = 0
	for (const node of nodes) {
		count++
		if (node.children) {
			count += countNodes(node.children)
		}
	}
	return count
}
