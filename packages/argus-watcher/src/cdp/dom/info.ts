import type { DomElementInfo, DomInfoResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../connection.js'
import type { CdpDescribeResult } from './types.js'
import { getDomRootId, resolveSelectorMatches, toAttributesRecord, countElementChildren, clamp } from './selector.js'

const DEFAULT_OUTER_HTML_MAX_CHARS = 50_000
const MAX_OUTER_HTML_CHARS = 500_000

type CdpOuterHtmlResult = {
	outerHTML?: string
}

/** Options for fetching DOM element info by selector. */
export type FetchDomInfoOptions = {
	selector: string
	all?: boolean
	outerHtmlMaxChars?: number
	text?: string
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
