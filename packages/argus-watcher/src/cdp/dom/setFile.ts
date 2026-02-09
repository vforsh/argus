import type { CdpSessionHandle } from '../connection.js'
import { getDomRootId, resolveSelectorMatches } from './selector.js'

/** Options for setting files on file input elements. */
export type SetFileInputFilesOptions = {
	selector: string
	files: string[]
	all?: boolean
	text?: string
}

/** Result of setFileInputFiles operation. */
export type SetFileInputFilesResult = {
	allNodeIds: number[]
	updatedCount: number
}

/** Set files on pre-resolved node IDs. Skips selector resolution. */
export const setFileOnResolvedNodes = async (session: CdpSessionHandle, nodeIds: number[], files: string[]): Promise<number> => {
	if (nodeIds.length === 0) return 0

	for (const nodeId of nodeIds) {
		await session.sendAndWait('DOM.setFileInputFiles', {
			files,
			nodeId,
		})
	}

	return nodeIds.length
}

/**
 * Set files on `<input type="file">` element(s) matching a CSS selector.
 * Uses CDP's `DOM.setFileInputFiles` which reads files directly from disk.
 */
export const setFileInputFiles = async (session: CdpSessionHandle, options: SetFileInputFilesOptions): Promise<SetFileInputFilesResult> => {
	await session.sendAndWait('DOM.enable')

	const rootId = await getDomRootId(session)
	const { allNodeIds, nodeIds } = await resolveSelectorMatches(session, rootId, options.selector, options.all ?? false, options.text)

	const updatedCount = await setFileOnResolvedNodes(session, nodeIds, options.files)
	return { allNodeIds, updatedCount }
}
