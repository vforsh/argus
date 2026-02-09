import type { CdpSessionHandle } from '../connection.js'
import { getDomRootId, resolveSelectorMatches } from './selector.js'

/** Options for filling input/textarea/contenteditable elements. */
export type FillElementsOptions = {
	selector: string
	value: string
	all?: boolean
	text?: string
}

/** Result of fillElements operation. */
export type FillElementsResult = {
	allNodeIds: number[]
	filledCount: number
}

/**
 * Browser-context function that sets the element value using the native
 * prototype setter (to bypass React/Vue/Angular property wrappers) and
 * dispatches input + change events so framework change detection fires.
 */
const FILL_FUNCTION = `function(value) {
	var el = this;
	if (el.isContentEditable) {
		el.focus();
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

/** Fill pre-resolved node IDs with a value. Skips selector resolution. */
export const fillResolvedNodes = async (session: CdpSessionHandle, nodeIds: number[], value: string): Promise<number> => {
	if (nodeIds.length === 0) return 0

	for (const nodeId of nodeIds) {
		const resolved = (await session.sendAndWait('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
		const objectId = resolved.object?.objectId
		if (!objectId) continue

		await session.sendAndWait('Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: FILL_FUNCTION,
			arguments: [{ value }],
			awaitPromise: false,
			returnByValue: true,
		})
	}

	return nodeIds.length
}

/**
 * Fill input/textarea/contenteditable element(s) with a value.
 * Uses the native setter trick to bypass framework property wrappers,
 * then dispatches input + change events so React/Vue/Angular detect the change.
 */
export const fillElements = async (session: CdpSessionHandle, options: FillElementsOptions): Promise<FillElementsResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, options.all ?? false, options.text)

	const filledCount = await fillResolvedNodes(session, nodeIds, options.value)
	return { allNodeIds, filledCount }
}
