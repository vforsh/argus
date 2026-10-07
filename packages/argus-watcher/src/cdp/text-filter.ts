import { randomUUID } from 'node:crypto'
import { parseTextPattern } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { formatPageException } from './pageState.js'

/**
 * Select and filter in the selected document's isolated world, materializing only matches.
 * `rootId`, when supplied, restricts selection to that DOM subtree. CSS selectors do not pierce
 * shadow roots, matching DOM.querySelectorAll. Main-world prototype/global overrides are ignored.
 * All temporary handles share a per-call group, released even on navigation or evaluation failure.
 */
export const queryNodesByText = async (session: CdpSessionHandle, selector: string, text: string, rootId?: number): Promise<number[]> => {
	const pattern = parseTextPattern(text)
	// requestNode needs a primed frontend document tree, including on a fresh CDP attachment.
	if (rootId == null) await session.sendAndWait('DOM.getDocument', { depth: 0 })
	const context = await session.getReadyTargetContext()
	const frameId = context?.kind === 'frame' ? context.frameId : (await session.sendAndWait('Page.getFrameTree')).frameTree?.frame.id
	if (!frameId) throw new Error('Unable to resolve frame for DOM text selection')

	const { executionContextId } = await session.sendAndWait('Page.createIsolatedWorld', { frameId, worldName: 'argus-dom' })
	const objectGroup = `argus-dom-${randomUUID()}`
	try {
		const objectId = rootId == null ? undefined : (await session.sendAndWait('DOM.resolveNode', {
			nodeId: rootId, executionContextId, objectGroup,
		})).object?.objectId
		if (rootId != null && !objectId) throw new Error('Unable to resolve DOM text selection root')

		const result = await session.sendAndWait('Runtime.callFunctionOn', {
			...(objectId ? { objectId } : { executionContextId }),
			functionDeclaration: SELECT_BY_TEXT,
			arguments: [
				{ value: selector },
				{ value: pattern.type === 'exact' ? pattern.value : pattern.regex.source },
				{ value: pattern.type === 'regex' ? pattern.regex.flags : null },
				{ value: rootId != null },
			],
			objectGroup,
			silent: true,
			returnByValue: false,
		})
		if (result.exceptionDetails) throw new Error(formatPageException(result.exceptionDetails))
		if (!result.result?.objectId) throw new Error('DOM text selection did not return node handles')

		const properties = await session.sendAndWait('Runtime.getProperties', { objectId: result.result.objectId, ownProperties: true })
		const nodeIds: number[] = []
		for (const property of properties.result ?? []) {
			if (!/^\d+$/.test(property.name) || !property.value?.objectId) continue
			const { nodeId } = await session.sendAndWait('DOM.requestNode', { objectId: property.value.objectId })
			if (nodeId) nodeIds.push(nodeId)
		}
		return nodeIds
	} finally {
		// Context destruction already releases its handles. Cleanup must not mask the original error.
		await session.sendAndWait('Runtime.releaseObjectGroup', { objectGroup }, { timeoutMs: 1_000 }).catch(() => {})
	}
}

const SELECT_BY_TEXT = `function(selector, value, flags, scoped) {
	const root = scoped ? this : document
	const regex = flags === null ? null : new RegExp(value, flags)
	const matches = []
	for (const node of root.querySelectorAll(selector)) {
		const text = node.textContent?.trim()
		if (typeof text !== 'string') continue
		if (regex ? regex.test(text) : text === value) matches.push(node)
		if (regex) regex.lastIndex = 0
	}
	return matches
}`
