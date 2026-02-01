import type { CdpSessionHandle } from './connection.js'

type TextPattern = { type: 'exact'; value: string } | { type: 'regex'; regex: RegExp }

const REGEX_PATTERN = /^\/(.+)\/([imsu]*)$/

/**
 * Parse a text filter string into either an exact match or a regex pattern.
 * `/pattern/flags` syntax is treated as regex; everything else is exact match.
 */
export const parseTextPattern = (text: string): TextPattern => {
	const match = REGEX_PATTERN.exec(text)
	if (!match) {
		return { type: 'exact', value: text }
	}

	const [, pattern, flags] = match
	try {
		return { type: 'regex', regex: new RegExp(pattern!, flags) }
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid regex in --text "${text}": ${msg}`)
	}
}

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
			if (pattern.regex.test(trimmedText)) {
				filtered.push(nodeId)
			}
		}
	}
	return filtered
}
