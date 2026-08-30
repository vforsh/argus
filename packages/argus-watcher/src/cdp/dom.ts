// Re-export shim — keeps `../cdp/dom.js` imports stable across the HTTP layer.

export { fetchDomSubtreeBySelector } from './dom/tree.js'
export type { FetchDomTreeOptions } from './dom/tree.js'

export { fetchDomInfoBySelector } from './dom/info.js'
export type { FetchDomInfoOptions } from './dom/info.js'

export {
	fillElements,
	fillResolvedNodes,
	insertAdjacentHtml,
	modifyElements,
	mutateMatchedElements,
	removeElements,
	setFileInputFiles,
	setFileOnResolvedNodes,
} from './dom/mutate.js'
export type { InsertAdjacentHtmlOptions, ModifyElementsOptions, MutationResult, MutationTarget } from './dom/mutate.js'
