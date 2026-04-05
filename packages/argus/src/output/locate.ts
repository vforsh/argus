import type { LocatedElement } from '@vforsh/argus-core'
import { formatNodeLabel } from './dom.js'

export const formatLocatedElements = (elements: LocatedElement[]): string => elements.map(formatLocatedElement).join('\n')

const formatLocatedElement = (element: LocatedElement): string => {
	const parts = [`${element.ref}`, element.role]
	if (element.name) {
		parts.push(`"${element.name}"`)
	}
	if (element.value != null) {
		parts.push(`value="${element.value}"`)
	}
	if (element.tag) {
		const label = element.attributes?.id || element.attributes?.class ? formatNodeLabel(elementSummary(element)) : `<${element.tag}>`
		parts.push(label)
	}
	return parts.join(' ')
}

const elementSummary = (element: LocatedElement) => ({
	nodeId: -1,
	tag: element.tag ?? 'unknown',
	attributes: element.attributes ?? {},
	childElementCount: 0,
	outerHTML: null,
	outerHTMLTruncated: false,
})
