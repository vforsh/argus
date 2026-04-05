import type { DomElementInfo, DomInfoResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../connection.js'
import type { ElementRefRegistry } from '../elementRefs.js'
import type { CdpDescribeResult } from './types.js'
import { clamp, countElementChildren, resolveElementTargets, toAttributesRecord, toDomNodeDescriptor } from './selector.js'

const DEFAULT_OUTER_HTML_MAX_CHARS = 50_000
const MAX_OUTER_HTML_CHARS = 500_000

type CdpOuterHtmlResult = {
	outerHTML?: string
}

/** Options for fetching DOM element info by selector. */
export type FetchDomInfoOptions = {
	selector?: string
	ref?: string
	all?: boolean
	outerHtmlMaxChars?: number
	text?: string
}

/**
 * Fetch detailed info for element(s) matching a CSS selector.
 */
export const fetchDomInfoBySelector = async (
	session: CdpSessionHandle,
	elementRefs: ElementRefRegistry,
	options: FetchDomInfoOptions,
): Promise<DomInfoResponse> => {
	const all = options.all ?? false
	const maxChars = clamp(options.outerHtmlMaxChars ?? DEFAULT_OUTER_HTML_MAX_CHARS, 0, MAX_OUTER_HTML_CHARS)

	const resolved = await resolveElementTargets(session, elementRefs, {
		selector: options.selector,
		ref: options.ref,
		all,
		text: options.text,
	})
	if (resolved.missingRef && options.ref) {
		throw Object.assign(new Error(`Unknown or stale element ref: ${options.ref}`), { code: 'invalid_ref' })
	}
	const { allHandles, handles } = resolved

	if (allHandles.length === 0) {
		return { ok: true, matches: 0, elements: [] }
	}

	const elements: DomElementInfo[] = []

	for (const handle of handles) {
		const descriptor = toDomNodeDescriptor(handle)
		const describeResult = (await session.sendAndWait('DOM.describeNode', {
			...descriptor,
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
			const htmlResult = (await session.sendAndWait('DOM.getOuterHTML', descriptor)) as CdpOuterHtmlResult
			outerHTML = htmlResult.outerHTML ?? null

			if (outerHTML && outerHTML.length > maxChars) {
				outerHTML = outerHTML.slice(0, maxChars)
				outerHTMLTruncated = true
			}
		} catch {
			// getOuterHTML can fail for certain nodes; leave as null
		}

		elements.push({
			ref: node.backendNodeId != null ? elementRefs.getOrCreate(node.backendNodeId) : undefined,
			nodeId: node.nodeId,
			tag: (node.localName ?? node.nodeName).toLowerCase(),
			attributes,
			childElementCount,
			outerHTML,
			outerHTMLTruncated,
		})
	}

	return { ok: true, matches: allHandles.length, elements }
}
