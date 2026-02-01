import type { CdpSessionHandle } from '../connection.js'
import { getDomRootId, resolveSelectorMatches } from './selector.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
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

/** Result of modifyElements operation. */
export type ModifyElementsResult = {
	allNodeIds: number[]
	modifiedCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modify element(s) matching a CSS selector.
 * Supports attribute, class, style, text, and HTML modifications.
 */
export const modifyElements = async (session: CdpSessionHandle, options: ModifyElementsOptions): Promise<ModifyElementsResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, options.all ?? false, options.text)

	if (nodeIds.length === 0) {
		return { allNodeIds, modifiedCount: 0 }
	}

	const fn = buildModifyFunction(options)

	for (const nodeId of nodeIds) {
		const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
		const objectId = resolved.object?.objectId
		if (!objectId) {
			continue
		}

		await session.sendAndWait('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: fn.code,
			arguments: fn.args,
			awaitPromise: false,
			returnByValue: true,
		})
	}

	return { allNodeIds, modifiedCount: nodeIds.length }
}

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
