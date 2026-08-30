import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalInteger, optionalNonEmptyString, readFields, requireObject } from '../schemaFields.js'
import type { Ok } from './errors.js'

/**
 * A node in the accessibility tree.
 * Reconstructed from CDP's flat AXNode array into a nested structure.
 */
export type AXTreeNode = {
	/** Stable element ref for actionable DOM-backed nodes (e.g. "e12"). */
	ref?: string
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
export type SnapshotResponse = Ok<{
	/** Root nodes of the accessibility tree. */
	roots: AXTreeNode[]
	/** Total number of nodes before filtering. */
	totalNodes: number
	/** Number of nodes after filtering. */
	returnedNodes: number
}>

/** Schema for POST /snapshot request payloads. */
export const snapshotRequestSchema = defineProtocolSchema<SnapshotRequest>((value) => {
	const invalid = requireObject<SnapshotRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		selector: optionalNonEmptyString,
		depth: (source, key) => optionalInteger(source, key, { min: 0 }),
		interactive: optionalBoolean,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})
