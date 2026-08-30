import { callFunctionOnNode } from '../pageState.js'
import type { CdpSessionHandle } from '../connection.js'
import { getDomRootId, resolveSelectorMatches } from './selector.js'

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
		await callFunctionOnNode(session, { nodeId }, { code: 'function() { this.remove(); }' })
	}

	return { allNodeIds, removedCount: nodeIds.length }
}
