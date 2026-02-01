import type { DomInsertPosition } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../connection.js'

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
