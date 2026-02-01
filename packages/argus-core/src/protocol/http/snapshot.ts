/**
 * A node in the accessibility tree.
 * Reconstructed from CDP's flat AXNode array into a nested structure.
 */
export type AXTreeNode = {
	/** Accessibility role (e.g. "button", "textbox", "heading", "link"). */
	role: string
	/** Accessible name (visible label or aria-label). */
	name: string
	/** Current value for inputs/selects/sliders. */
	value?: string
	/** Relevant state properties. */
	properties?: Record<string, string | number | boolean>
	/** Child nodes in the accessibility tree. */
	children?: AXTreeNode[]
}

/**
 * Request payload for POST /snapshot.
 */
export type SnapshotRequest = {
	/** CSS selector to scope the snapshot to a DOM subtree. */
	selector?: string
	/** Max depth to traverse. */
	depth?: number
	/** If true, only return interactive elements (buttons, links, inputs, etc.). */
	interactive?: boolean
}

/**
 * Response payload for POST /snapshot.
 */
export type SnapshotResponse = {
	ok: true
	/** Root nodes of the accessibility tree. */
	roots: AXTreeNode[]
	/** Total number of nodes before filtering. */
	totalNodes: number
	/** Number of nodes after filtering. */
	returnedNodes: number
}
