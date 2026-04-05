import type { AXTreeNode, SnapshotResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import type { ElementRefRegistry } from './elementRefs.js'
import { resolveFirstSelectorNodeId } from './dom/selector.js'

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

export type AccessibleElementRecord = {
	backendNodeId: number
	ref: string
	role: string
	name: string
	value?: string
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
export const fetchAccessibilitySnapshot = async (
	session: CdpSessionHandle,
	options: FetchSnapshotOptions,
	elementRefs: ElementRefRegistry,
): Promise<SnapshotResponse> => {
	await session.sendAndWait('Accessibility.enable')
	const nodes = await resolveAccessibilityNodes(session, options.selector)

	const totalNodes = nodes.length

	const roots = buildTree(nodes, {
		depth: options.depth,
		interactive: options.interactive ?? false,
		elementRefs,
	})

	const returnedNodes = countNodes(roots)

	return { ok: true as const, roots, totalNodes, returnedNodes }
}

export const listAccessibleElements = async (
	session: CdpSessionHandle,
	elementRefs: ElementRefRegistry,
	options: { selector?: string } = {},
): Promise<AccessibleElementRecord[]> => {
	const nodes = await resolveAccessibilityNodes(session, options.selector)
	return collectAccessibleElements(nodes, elementRefs)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree reconstruction
// ─────────────────────────────────────────────────────────────────────────────

type BuildTreeOptions = {
	depth?: number
	interactive: boolean
	elementRefs: ElementRefRegistry
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
	if (cdpNode.backendDOMNodeId != null) {
		result.ref = options.elementRefs.getOrCreate(cdpNode.backendDOMNodeId)
	}

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

const fetchAccessibilityNodes = async (session: CdpSessionHandle): Promise<CdpAXNode[]> => {
	const axResult = (await session.sendAndWait('Accessibility.getFullAXTree')) as CdpAXTreeResult
	return axResult.nodes ?? []
}

const resolveAccessibilityNodes = async (session: CdpSessionHandle, selector?: string): Promise<CdpAXNode[]> => {
	// Always fetch the full tree — getPartialAXTree with fetchRelatives:false
	// returns only a single node without descendants, which is not useful.
	const nodes = await fetchAccessibilityNodes(session)
	if (!selector) {
		return nodes
	}

	return filterAccessibilityNodesBySelector(session, nodes, selector)
}

const filterAccessibilityNodesBySelector = async (session: CdpSessionHandle, nodes: CdpAXNode[], selector: string): Promise<CdpAXNode[]> => {
	const domNodeId = await resolveFirstSelectorNodeId(session, selector)
	if (!domNodeId) {
		throw new Error(`No element found for selector: ${selector}`)
	}

	// Load the subtree below the resolved root so we can translate DOM membership to AX nodes.
	await session.sendAndWait('DOM.getDocument', { depth: -1 })

	const allDescendants = (await session.sendAndWait('DOM.querySelectorAll', {
		nodeId: domNodeId,
		selector: '*',
	})) as { nodeIds?: number[] }
	const descendantNodeIds = allDescendants.nodeIds ?? []

	const backendIds = new Set<number>()
	const allDomNodeIds = [domNodeId, ...descendantNodeIds]
	for (const nid of allDomNodeIds) {
		const desc = (await session.sendAndWait('DOM.describeNode', { nodeId: nid, depth: 0 })) as {
			node?: { backendNodeId?: number }
		}
		if (desc.node?.backendNodeId != null) {
			backendIds.add(desc.node.backendNodeId)
		}
	}

	return filterByDomSubtree(nodes, backendIds)
}

const collectAccessibleElements = (nodes: CdpAXNode[], elementRefs: ElementRefRegistry): AccessibleElementRecord[] => {
	const byBackendId = new Map<number, AccessibleElementRecord>()

	for (const node of nodes) {
		if (node.ignored || node.backendDOMNodeId == null) {
			continue
		}

		const role = extractStringValue(node.role) ?? 'unknown'
		if (role === 'InlineTextBox') {
			continue
		}

		const name = extractStringValue(node.name) ?? ''
		const value = extractStringValue(node.value)
		const next: AccessibleElementRecord = {
			backendNodeId: node.backendDOMNodeId,
			ref: elementRefs.getOrCreate(node.backendDOMNodeId),
			role,
			name,
			value: value && value !== '' ? value : undefined,
		}

		const existing = byBackendId.get(node.backendDOMNodeId)
		if (!existing || scoreAccessibleElement(next) > scoreAccessibleElement(existing)) {
			byBackendId.set(node.backendDOMNodeId, next)
		}
	}

	return [...byBackendId.values()]
}

const scoreAccessibleElement = (record: AccessibleElementRecord): number => {
	let score = 0
	if (!GENERIC_ROLES.has(record.role)) {
		score += 10
	}
	if (record.name) {
		score += 5
	}
	if (INTERACTIVE_ROLES.has(record.role)) {
		score += 3
	}
	if (record.value) {
		score += 1
	}
	return score
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
