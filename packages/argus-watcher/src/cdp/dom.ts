import type { DomNode, DomElementInfo, DomTreeResponse, DomInfoResponse, DomInsertPosition } from '@vforsh/argus-core'
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
	text?: string
}

/** Options for fetching DOM element info by selector. */
export type FetchDomInfoOptions = {
	selector: string
	all?: boolean
	outerHtmlMaxChars?: number
	text?: string
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

/**
 * Fetch detailed info for element(s) matching a CSS selector.
 */
export const fetchDomInfoBySelector = async (session: CdpSessionHandle, options: FetchDomInfoOptions): Promise<DomInfoResponse> => {
	const all = options.all ?? false
	const maxChars = clamp(options.outerHtmlMaxChars ?? DEFAULT_OUTER_HTML_MAX_CHARS, 0, MAX_OUTER_HTML_CHARS)

	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, all, options.text)

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

const resolveSelectorMatches = async (
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

const filterNodesByText = async (session: CdpSessionHandle, nodeIds: number[], text: string): Promise<number[]> => {
	const filtered: number[] = []
	for (const nodeId of nodeIds) {
		const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
		const objectId = resolved.object?.objectId
		if (!objectId) {
			continue
		}
		const evalResult = (await session.sendAndWait('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: 'function() { return this.textContent?.trim(); }',
			returnByValue: true,
		})) as { result?: { value?: unknown } }
		if (evalResult.result?.value === text) {
			filtered.push(nodeId)
		}
	}
	return filtered
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

// ─────────────────────────────────────────────────────────────────────────────
// DOM manipulation
// ─────────────────────────────────────────────────────────────────────────────

/** Options for inserting HTML adjacent to matched elements. */
export type InsertAdjacentHtmlOptions = {
	nodeIds: number[]
	html: string
	position?: DomInsertPosition
	text?: boolean
}

/** Result of insertAdjacentHtml operation. */
export type InsertAdjacentHtmlResult = {
	insertedCount: number
}

/**
 * Insert HTML adjacent to element(s) matching a CSS selector.
 * Uses insertAdjacentHTML on each matched element.
 */
export const insertAdjacentHtml = async (session: CdpSessionHandle, options: InsertAdjacentHtmlOptions): Promise<InsertAdjacentHtmlResult> => {
	await session.sendAndWait('DOM.enable')

	if (options.nodeIds.length === 0) {
		return { insertedCount: 0 }
	}

	const position = options.position ?? 'beforeend'
	const functionDeclaration = options.text
		? 'function(pos, value) { this.insertAdjacentText(pos, value); }'
		: 'function(pos, html) { this.insertAdjacentHTML(pos, html); }'

	for (const nodeId of options.nodeIds) {
		const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
		const objectId = resolved.object?.objectId
		if (!objectId) {
			continue
		}

		await session.sendAndWait('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration,
			arguments: [{ value: position }, { value: options.html }],
			awaitPromise: false,
			returnByValue: true,
		})
	}

	return { insertedCount: options.nodeIds.length }
}

/** Options for removing matched elements. */
export type RemoveElementsOptions = {
	selector: string
	all?: boolean
	text?: string
}

/** Result of removeElements operation. */
export type RemoveElementsResult = {
	allNodeIds: number[]
	removedCount: number
}

/**
 * Remove element(s) matching a CSS selector from the DOM.
 */
export const removeElements = async (session: CdpSessionHandle, options: RemoveElementsOptions): Promise<RemoveElementsResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, options.all ?? false, options.text)

	if (nodeIds.length === 0) {
		return { allNodeIds, removedCount: 0 }
	}

	for (const nodeId of nodeIds) {
		const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
		const objectId = resolved.object?.objectId
		if (!objectId) {
			continue
		}

		await session.sendAndWait('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: 'function() { this.remove(); }',
			awaitPromise: false,
			returnByValue: true,
		})
	}

	return { allNodeIds, removedCount: nodeIds.length }
}

/** Base options for modifying matched elements. */
type ModifyElementsBaseOptions = {
	selector: string
	all?: boolean
	text?: string
}

/** Attribute modification options. */
type ModifyAttrOptions = ModifyElementsBaseOptions & {
	type: 'attr'
	set?: Record<string, string | true>
	remove?: string[]
}

/** Class modification options. */
type ModifyClassOptions = ModifyElementsBaseOptions & {
	type: 'class'
	add?: string[]
	remove?: string[]
	toggle?: string[]
}

/** Style modification options. */
type ModifyStyleOptions = ModifyElementsBaseOptions & {
	type: 'style'
	set?: Record<string, string>
	remove?: string[]
}

/** Text content modification options. */
type ModifyTextOptions = ModifyElementsBaseOptions & {
	type: 'text'
	value: string
}

/** HTML content modification options. */
type ModifyHtmlOptions = ModifyElementsBaseOptions & {
	type: 'html'
	value: string
}

/** Options for modifying matched elements. */
export type ModifyElementsOptions = ModifyAttrOptions | ModifyClassOptions | ModifyStyleOptions | ModifyTextOptions | ModifyHtmlOptions

/** Result of modifyElements operation. */
export type ModifyElementsResult = {
	allNodeIds: number[]
	modifiedCount: number
}

/**
 * Modify element(s) matching a CSS selector.
 * Supports attribute, class, style, text, and HTML modifications.
 */
export const modifyElements = async (session: CdpSessionHandle, options: ModifyElementsOptions): Promise<ModifyElementsResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, options.all ?? false, options.text)

	if (nodeIds.length === 0) {
		return { allNodeIds, modifiedCount: 0 }
	}

	const fn = buildModifyFunction(options)

	for (const nodeId of nodeIds) {
		const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
		const objectId = resolved.object?.objectId
		if (!objectId) {
			continue
		}

		await session.sendAndWait('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: fn.code,
			arguments: fn.args,
			awaitPromise: false,
			returnByValue: true,
		})
	}

	return { allNodeIds, modifiedCount: nodeIds.length }
}

type ModifyFunction = {
	code: string
	args: Array<{ value: unknown }>
}

// ─────────────────────────────────────────────────────────────────────────────
// File input
// ─────────────────────────────────────────────────────────────────────────────

/** Options for setting files on file input elements. */
export type SetFileInputFilesOptions = {
	selector: string
	files: string[]
	all?: boolean
	text?: string
}

/** Result of setFileInputFiles operation. */
export type SetFileInputFilesResult = {
	allNodeIds: number[]
	updatedCount: number
}

/**
 * Set files on `<input type="file">` element(s) matching a CSS selector.
 * Uses CDP's `DOM.setFileInputFiles` which reads files directly from disk.
 */
export const setFileInputFiles = async (session: CdpSessionHandle, options: SetFileInputFilesOptions): Promise<SetFileInputFilesResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, options.all ?? false, options.text)

	if (nodeIds.length === 0) {
		return { allNodeIds, updatedCount: 0 }
	}

	for (const nodeId of nodeIds) {
		await session.sendAndWait('DOM.setFileInputFiles', {
			files: options.files,
			nodeId,
		})
	}

	return { allNodeIds, updatedCount: nodeIds.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Modify helpers
// ─────────────────────────────────────────────────────────────────────────────

const buildModifyFunction = (options: ModifyElementsOptions): ModifyFunction => {
	switch (options.type) {
		case 'attr':
			return {
				code: `function(toSet, toRemove) {
					if (toSet) {
						for (const [name, value] of Object.entries(toSet)) {
							if (value === true) {
								this.setAttribute(name, '');
							} else {
								this.setAttribute(name, value);
							}
						}
					}
					if (toRemove) {
						for (const name of toRemove) {
							this.removeAttribute(name);
						}
					}
				}`,
				args: [{ value: options.set ?? null }, { value: options.remove ?? null }],
			}

		case 'class':
			return {
				code: `function(toAdd, toRemove, toToggle) {
					if (toAdd) {
						this.classList.add(...toAdd);
					}
					if (toRemove) {
						this.classList.remove(...toRemove);
					}
					if (toToggle) {
						for (const cls of toToggle) {
							this.classList.toggle(cls);
						}
					}
				}`,
				args: [{ value: options.add ?? null }, { value: options.remove ?? null }, { value: options.toggle ?? null }],
			}

		case 'style':
			return {
				code: `function(toSet, toRemove) {
					if (toSet) {
						for (const [prop, value] of Object.entries(toSet)) {
							this.style.setProperty(prop, value);
						}
					}
					if (toRemove) {
						for (const prop of toRemove) {
							this.style.removeProperty(prop);
						}
					}
				}`,
				args: [{ value: options.set ?? null }, { value: options.remove ?? null }],
			}

		case 'text':
			return {
				code: `function(value) { this.textContent = value; }`,
				args: [{ value: options.value }],
			}

		case 'html':
			return {
				code: `function(value) { this.innerHTML = value; }`,
				args: [{ value: options.value }],
			}
	}
}
