import type { ElementRef } from './dom.js'

/** Common matching options for semantic element lookup commands. */
export type LocateMatchOptions = {
	/** Allow multiple matches. If false and >1 match, the route returns an ambiguity error. */
	all?: boolean
	/** Require an exact normalized string match instead of substring matching. */
	exact?: boolean
}

/** Element summary returned by semantic locator routes. */
export type LocatedElement = {
	/** Stable element ref that can be reused by ref-aware commands. */
	ref: ElementRef
	/** Accessibility role used for semantic lookup. */
	role: string
	/** Accessible name / label for the element. */
	name: string
	/** Current accessible value when relevant. */
	value?: string
	/** Lower-cased DOM tag name when it can be resolved. */
	tag?: string
	/** Selected DOM attributes useful for quick inspection. */
	attributes?: Record<string, string>
}

export type LocateRoleRequest = LocateMatchOptions & {
	/** Accessibility role to match (e.g. "button", "textbox", "link"). */
	role: string
	/** Optional accessible name to match against the role result set. */
	name?: string
}

export type LocateTextRequest = LocateMatchOptions & {
	/** Visible/accessible text to match against element names/values. */
	text: string
}

export type LocateLabelRequest = LocateMatchOptions & {
	/** Form label / accessible name to match. */
	label: string
}

/** Shared response payload for `/locate/*` routes. */
export type LocateResponse = {
	ok: true
	/** Number of matched semantic elements before any `all=false` truncation. */
	matches: number
	/** Element summaries for the resolved matches. */
	elements: LocatedElement[]
}
