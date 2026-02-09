// Re-export shim — keeps `../cdp/dom.js` imports stable across the HTTP layer.

export { fetchDomSubtreeBySelector } from './dom/tree.js'
export type { FetchDomTreeOptions } from './dom/tree.js'

export { fetchDomInfoBySelector } from './dom/info.js'
export type { FetchDomInfoOptions } from './dom/info.js'

export { insertAdjacentHtml } from './dom/insert.js'
export type { InsertAdjacentHtmlOptions, InsertAdjacentHtmlResult } from './dom/insert.js'

export { removeElements } from './dom/remove.js'
export type { RemoveElementsOptions, RemoveElementsResult } from './dom/remove.js'

export { modifyElements } from './dom/modify.js'
export type { ModifyElementsOptions, ModifyElementsResult } from './dom/modify.js'

export { setFileInputFiles, setFileOnResolvedNodes } from './dom/setFile.js'
export type { SetFileInputFilesOptions, SetFileInputFilesResult } from './dom/setFile.js'

export { fillElements, fillResolvedNodes } from './dom/fill.js'
export type { FillElementsOptions, FillElementsResult } from './dom/fill.js'
