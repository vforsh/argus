import { matchesTextPattern, parseTextPattern } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

/**
 * Filter CDP node IDs by textContent, supporting exact match and /regex/flags.
 */
export const filterNodesByText = async (session: CdpSessionHandle, nodeIds: number[], text: string): Promise<number[]> => {
	const pattern = parseTextPattern(text)
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
		const trimmedText = evalResult.result?.value
		if (typeof trimmedText !== 'string') {
			continue
		}
		if (pattern.type === 'exact') {
			if (trimmedText === pattern.value) {
				filtered.push(nodeId)
			}
		} else {
			if (matchesTextPattern(trimmedText, pattern)) {
				filtered.push(nodeId)
			}
		}
	}
	return filtered
}
