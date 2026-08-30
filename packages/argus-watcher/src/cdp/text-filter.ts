import { callFunctionOnNode } from './pageState.js'
import { matchesTextPattern, parseTextPattern } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

/**
 * Filter CDP node IDs by textContent, supporting exact match and /regex/flags.
 */
export const filterNodesByText = async (session: CdpSessionHandle, nodeIds: number[], text: string): Promise<number[]> => {
	const pattern = parseTextPattern(text)
	const filtered: number[] = []
	for (const nodeId of nodeIds) {
		const trimmedText = await callFunctionOnNode(session, { nodeId }, { code: 'function() { return this.textContent?.trim(); }' })
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
