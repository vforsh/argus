import type { DomInsertPosition } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../connection.js'
import { callFunctionOnNode, type PageFunction } from '../pageState.js'
import { getDomRootId, resolveSelectorMatches, toDomNodeDescriptor, type DomNodeHandle } from './selector.js'

/**
 * DOM mutations driven by a CSS selector.
 *
 * modify/remove/insert/fill/setFile were five files running the same program —
 * `DOM.enable` → resolve the document root → resolve selector matches → apply one action
 * per node → report `{ allNodeIds, count }` — differing only in the page-side function.
 * They share {@link mutateMatchedElements} here, with the per-action code as the only
 * thing each one still owns.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared driver
// ─────────────────────────────────────────────────────────────────────────────

/** The selector target every mutation accepts. */
export type MutationTarget = {
	selector: string
	all?: boolean
	text?: string
}

/** Outcome of a selector-driven mutation. */
export type MutationResult = {
	/** Every node the selector matched, before the `all` filter. */
	allNodeIds: number[]
	/** How many nodes the action was applied to. */
	mutatedCount: number
}

/**
 * Resolve a selector and apply an action to each matched node.
 *
 * @param apply Runs once per matched node. Nodes that detach between resolution and use
 *   are still counted — matching the behavior every caller had before this was shared.
 */
export const mutateMatchedElements = async (
	session: CdpSessionHandle,
	target: MutationTarget,
	apply: (nodeId: number) => Promise<unknown>,
): Promise<MutationResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, target.selector, target.all ?? false, target.text)

	for (const nodeId of nodeIds) {
		await apply(nodeId)
	}

	return { allNodeIds, mutatedCount: nodeIds.length }
}

/** Apply a page function to each node matched by a selector. */
const mutateWithPageFunction = (session: CdpSessionHandle, target: MutationTarget, fn: PageFunction): Promise<MutationResult> =>
	mutateMatchedElements(session, target, (nodeId) => callFunctionOnNode(session, { nodeId }, fn))

// ─────────────────────────────────────────────────────────────────────────────
// Remove
// ─────────────────────────────────────────────────────────────────────────────

/** Remove element(s) matching a CSS selector from the DOM. */
export const removeElements = (session: CdpSessionHandle, options: MutationTarget): Promise<MutationResult> =>
	mutateWithPageFunction(session, options, { code: 'function() { this.remove(); }' })

// ─────────────────────────────────────────────────────────────────────────────
// Modify
// ─────────────────────────────────────────────────────────────────────────────

/** Base options for modifying matched elements. */
type ModifyElementsBaseOptions = {
	selector: string
	all?: boolean
	text?: string
}

/** Attribute modification options. */
type ModifyAttrOptions = ModifyElementsBaseOptions & {
	type: 'attr'
	set?: Record<string, string | true>
	remove?: string[]
}

/** Class modification options. */
type ModifyClassOptions = ModifyElementsBaseOptions & {
	type: 'class'
	add?: string[]
	remove?: string[]
	toggle?: string[]
}

/** Style modification options. */
type ModifyStyleOptions = ModifyElementsBaseOptions & {
	type: 'style'
	set?: Record<string, string>
	remove?: string[]
}

/** Text content modification options. */
type ModifyTextOptions = ModifyElementsBaseOptions & {
	type: 'text'
	value: string
}

/** HTML content modification options. */
type ModifyHtmlOptions = ModifyElementsBaseOptions & {
	type: 'html'
	value: string
}

/** Options for modifying matched elements. */
export type ModifyElementsOptions = ModifyAttrOptions | ModifyClassOptions | ModifyStyleOptions | ModifyTextOptions | ModifyHtmlOptions

/**
 * Modify element(s) matching a CSS selector.
 * Supports attribute, class, style, text, and HTML modifications.
 */
export const modifyElements = (session: CdpSessionHandle, options: ModifyElementsOptions): Promise<MutationResult> =>
	mutateWithPageFunction(session, options, buildModifyFunction(options))

// ─────────────────────────────────────────────────────────────────────────────
// Fill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Browser-context function that sets the element value using the native
 * prototype setter (to bypass React/Vue/Angular property wrappers) and
 * dispatches input + change events so framework change detection fires.
 */
const FILL_FUNCTION = `function(value) {
	var el = this;
	el.focus();
	if (el.isContentEditable) {
		el.textContent = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return;
	}
	var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
		: el.tagName === 'SELECT' ? HTMLSelectElement.prototype
		: HTMLInputElement.prototype;
	var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
	if (nativeSetter && nativeSetter.set) {
		nativeSetter.set.call(el, value);
	} else {
		el.value = value;
	}
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
}`

/** Fill pre-resolved nodes with a value. Skips selector resolution. */
export const fillResolvedNodes = async (session: CdpSessionHandle, handles: DomNodeHandle[], value: string): Promise<number> => {
	for (const handle of handles) {
		await callFunctionOnNode(session, toDomNodeDescriptor(handle), { code: FILL_FUNCTION, args: [{ value }] })
	}

	return handles.length
}

/** Fill input/textarea/contenteditable element(s) matching a CSS selector. */
export const fillElements = (session: CdpSessionHandle, options: MutationTarget & { value: string }): Promise<MutationResult> =>
	mutateWithPageFunction(session, options, { code: FILL_FUNCTION, args: [{ value: options.value }] })

// ─────────────────────────────────────────────────────────────────────────────
// Insert
// ─────────────────────────────────────────────────────────────────────────────

/** Options for inserting HTML adjacent to already-resolved elements. */
export type InsertAdjacentHtmlOptions = {
	nodeIds: number[]
	html: string
	position?: DomInsertPosition
	text?: boolean
}

/**
 * Insert HTML (or text) adjacent to already-resolved elements.
 *
 * Takes node ids rather than a selector because `/dom/add` resolves matches itself to
 * honor its `nth` and `expect` guards before mutating anything.
 */
export const insertAdjacentHtml = async (session: CdpSessionHandle, options: InsertAdjacentHtmlOptions): Promise<number> => {
	if (options.nodeIds.length === 0) {
		return 0
	}

	await session.sendAndWait('DOM.enable')

	const fn: PageFunction = {
		code: options.text
			? 'function(pos, value) { this.insertAdjacentText(pos, value); }'
			: 'function(pos, html) { this.insertAdjacentHTML(pos, html); }',
		args: [{ value: options.position ?? 'beforeend' }, { value: options.html }],
	}

	for (const nodeId of options.nodeIds) {
		await callFunctionOnNode(session, { nodeId }, fn)
	}

	return options.nodeIds.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Set file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set files on already-resolved `<input type="file">` nodes.
 *
 * Uses CDP's `DOM.setFileInputFiles`, which reads from disk on the watcher host — there
 * is no page function for this one.
 */
export const setFileOnResolvedNodes = async (session: CdpSessionHandle, nodeIds: number[], files: string[]): Promise<number> => {
	for (const nodeId of nodeIds) {
		await session.sendAndWait('DOM.setFileInputFiles', { files, nodeId })
	}

	return nodeIds.length
}

/** Set files on `<input type="file">` element(s) matching a CSS selector. */
export const setFileInputFiles = (session: CdpSessionHandle, options: MutationTarget & { files: string[] }): Promise<MutationResult> =>
	mutateMatchedElements(session, options, (nodeId) => session.sendAndWait('DOM.setFileInputFiles', { files: options.files, nodeId }))

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type ModifyFunction = {
	code: string
	args: Array<{ value: unknown }>
}

const buildModifyFunction = (options: ModifyElementsOptions): ModifyFunction => {
	switch (options.type) {
		case 'attr':
			return {
				code: `function(toSet, toRemove) {
					if (toSet) {
						for (const [name, value] of Object.entries(toSet)) {
							if (value === true) {
								this.setAttribute(name, '');
							} else {
								this.setAttribute(name, value);
							}
						}
					}
					if (toRemove) {
						for (const name of toRemove) {
							this.removeAttribute(name);
						}
					}
				}`,
				args: [{ value: options.set ?? null }, { value: options.remove ?? null }],
			}

		case 'class':
			return {
				code: `function(toAdd, toRemove, toToggle) {
					if (toAdd) {
						this.classList.add(...toAdd);
					}
					if (toRemove) {
						this.classList.remove(...toRemove);
					}
					if (toToggle) {
						for (const cls of toToggle) {
							this.classList.toggle(cls);
						}
					}
				}`,
				args: [{ value: options.add ?? null }, { value: options.remove ?? null }, { value: options.toggle ?? null }],
			}

		case 'style':
			return {
				code: `function(toSet, toRemove) {
					if (toSet) {
						for (const [prop, value] of Object.entries(toSet)) {
							this.style.setProperty(prop, value);
						}
					}
					if (toRemove) {
						for (const prop of toRemove) {
							this.style.removeProperty(prop);
						}
					}
				}`,
				args: [{ value: options.set ?? null }, { value: options.remove ?? null }],
			}

		case 'text':
			return {
				code: `function(value) { this.textContent = value; }`,
				args: [{ value: options.value }],
			}

		case 'html':
			return {
				code: `function(value) { this.innerHTML = value; }`,
				args: [{ value: options.value }],
			}
	}
}
