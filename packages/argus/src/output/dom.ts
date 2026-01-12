import type { DomNode, DomElementInfo } from '@vforsh/argus-core'

/**
 * Format a DomNode as a compact label: <tag#id.class1.class2>
 */
export const formatNodeLabel = (node: DomNode | DomElementInfo): string => {
	let label = node.tag
	if (node.attributes.id) {
		label += `#${node.attributes.id}`
	}
	if (node.attributes.class) {
		const classes = node.attributes.class.trim().split(/\s+/).filter(Boolean)
		for (const cls of classes) {
			label += `.${cls}`
		}
	}
	return `<${label}>`
}

/**
 * Format a DOM tree as indented human-readable text.
 */
export const formatDomTree = (roots: DomNode[], truncated: boolean, truncatedReason?: string): string => {
	const lines: string[] = []

	for (const root of roots) {
		formatNodeRecursive(root, 0, lines)
	}

	if (truncated && truncatedReason) {
		lines.push('')
		lines.push(`(output truncated: ${truncatedReason === 'max_nodes' ? 'max nodes reached' : 'max depth reached'})`)
	}

	return lines.join('\n')
}

const formatNodeRecursive = (node: DomNode, depth: number, lines: string[]): void => {
	const indent = '  '.repeat(depth)
	let line = `${indent}${formatNodeLabel(node)}`
	if (node.truncated) {
		line += ' ...'
	}
	lines.push(line)

	if (node.children) {
		for (const child of node.children) {
			formatNodeRecursive(child, depth + 1, lines)
		}
	}
}

/**
 * Format element info for human output.
 */
export const formatDomInfo = (elements: DomElementInfo[]): string => {
	const lines: string[] = []

	for (let i = 0; i < elements.length; i++) {
		if (i > 0) {
			lines.push('')
			lines.push('---')
			lines.push('')
		}
		formatElementInfo(elements[i], lines)
	}

	return lines.join('\n')
}

const formatElementInfo = (element: DomElementInfo, lines: string[]): void => {
	lines.push(formatNodeLabel(element))
	lines.push('')

	// Attributes (sorted by key)
	const attrKeys = Object.keys(element.attributes).sort()
	if (attrKeys.length > 0) {
		lines.push('Attributes:')
		for (const key of attrKeys) {
			const value = element.attributes[key]
			lines.push(`  ${key}="${escapeAttrValue(value)}"`)
		}
	} else {
		lines.push('Attributes: (none)')
	}

	lines.push('')
	lines.push(`Child elements: ${element.childElementCount}`)

	// outerHTML
	lines.push('')
	if (element.outerHTML === null) {
		lines.push('outerHTML: (unavailable)')
	} else {
		lines.push('outerHTML:')
		lines.push(element.outerHTML)
		if (element.outerHTMLTruncated) {
			lines.push('(truncated)')
		}
	}
}

const escapeAttrValue = (value: string): string => {
	return value.replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
