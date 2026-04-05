import type { AXTreeNode } from '@vforsh/argus-core'

/**
 * Format an accessibility tree as indented human-readable text.
 *
 * Output format per node:
 *   role "name" value="current value" [prop1, prop2=val2]
 *
 * Examples:
 *   heading "Settings" [level=2]
 *   textbox "Username" value="alice" [required]
 *   button "Submit" [disabled]
 *   checkbox "Remember me" [checked]
 *   link "Home"
 */
export const formatAccessibilityTree = (roots: AXTreeNode[]): string => {
	const lines: string[] = []
	for (const root of roots) {
		formatNodeRecursive(root, 0, lines)
	}
	return lines.join('\n')
}

const formatNodeRecursive = (node: AXTreeNode, depth: number, lines: string[]): void => {
	const indent = '  '.repeat(depth)
	const label = formatNodeLabel(node)
	lines.push(`${indent}${label}`)

	if (node.children) {
		for (const child of node.children) {
			formatNodeRecursive(child, depth + 1, lines)
		}
	}
}

const formatNodeLabel = (node: AXTreeNode): string => {
	const parts: string[] = [node.role]

	if (node.name) {
		parts.push(`"${node.name}"`)
	}

	if (node.value != null) {
		parts.push(`value="${node.value}"`)
	}

	const propStr = formatProperties(node.ref, node.properties)
	if (propStr) {
		parts.push(propStr)
	}

	return parts.join(' ')
}

const formatProperties = (ref?: string, properties?: Record<string, string | number | boolean>): string | null => {
	if (!ref && !properties) {
		return null
	}

	const formatted: string[] = []
	if (ref) {
		formatted.push(`ref=${ref}`)
	}

	if (properties) {
		const entries = Object.entries(properties)
		for (const [key, val] of entries) {
			if (typeof val === 'boolean') {
				formatted.push(key)
				continue
			}
			formatted.push(`${key}=${val}`)
		}
	}

	return formatted.length > 0 ? `[${formatted.join(', ')}]` : null
}
