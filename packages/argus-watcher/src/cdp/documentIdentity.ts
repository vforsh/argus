import type { CdpSessionHandle } from './connection.js'
import type { CdpFrameTreeNode } from './protocol.js'
import { codedError } from '../errors.js'

/**
 * Which document a command would run in, so a `--until` poll after `reload`/`goto` can tell the
 * new page from the one the action navigated away from.
 *
 * Chrome answers `Page.reload` ~150ms after the reload *starts*; the old document (and the iframe
 * inside it) keeps running until the new navigation commits, so a poll sent straight after the
 * action evaluated in the old page and matched a condition that page had already met.
 *
 * The identity is navigation-scoped, not a JS marker: `frameId:loaderId` of the top frame and of
 * the selected target (the same frame when no iframe is selected). Every cross-document commit
 * gets a fresh loader id, and an iframe the host page re-creates gets a fresh frame id too.
 */
export type DocumentSessions = {
	/** Pinned to the top-level page, whatever target is selected. */
	page: CdpSessionHandle
	/** Follows the selected target (an iframe in the extension, or a direct CDP target). */
	target: CdpSessionHandle
}

/** Budget for reading the pre-action identity; a selected iframe that is not ready by then is recorded as unknown. */
const BASELINE_READ_TIMEOUT_MS = 1_000

const SEPARATOR = '|'

/**
 * Identity of the selected target's document right before a navigating action.
 *
 * Never throws: a navigating action must not fail because its bookkeeping could not read the
 * page. An unreadable part is left empty and the check falls back to the other part.
 */
export const readNavigationBaseline = async (sessions: DocumentSessions): Promise<string> => {
	const top = await readFrameDocument(sessions.page, null, BASELINE_READ_TIMEOUT_MS).catch(() => null)
	const target = isFrameTarget(sessions.target)
		? await readFrameDocument(sessions.target, 'selected', BASELINE_READ_TIMEOUT_MS).catch(() => null)
		: top
	return [top ?? '', target ?? ''].join(SEPARATOR)
}

/**
 * Fail with `navigation_pending` while the selected target still shows the document `baseline`
 * names (or the host page has not committed its navigation yet).
 *
 * A selected iframe that is missing or booting throws `extension_frame_missing`/`_not_ready` from
 * the read itself, so callers keep their existing "not yet" handling for those.
 */
export const assertNavigatedPast = async (sessions: DocumentSessions, baseline: string, timeoutMs: number): Promise<void> => {
	const [baseTop = '', baseTarget = ''] = baseline.split(SEPARATOR)
	const top = await readFrameDocument(sessions.page, null, timeoutMs)
	// The host commit comes first: until it does, the old iframe is still alive and still mapped.
	if (baseTop && top === baseTop) throw navigationPending()

	const target = isFrameTarget(sessions.target) ? await readFrameDocument(sessions.target, 'selected', timeoutMs) : top
	if (target == null || (baseTarget && target === baseTarget)) throw navigationPending()
}

const navigationPending = (): Error =>
	codedError(
		'navigation_pending',
		'The selected target still shows the document from before the navigation; the new one has not committed yet.',
	)

const isFrameTarget = (session: CdpSessionHandle): boolean => session.getTargetContext().kind === 'frame'

/**
 * `frameId:loaderId` of the top frame (`null`) or of the selected frame (`'selected'`), or `null`
 * when the frame is not in the tree.
 *
 * The selected frame id is read after the call: the extension re-resolves a selection whose
 * iframe was re-created while the command waited for it. An out-of-process iframe answers from
 * its own session, where it is the root.
 */
const readFrameDocument = async (session: CdpSessionHandle, frame: 'selected' | null, timeoutMs: number): Promise<string | null> => {
	const { frameTree } = await session.sendAndWait('Page.getFrameTree', undefined, { timeoutMs })
	if (!frameTree) return null

	const context = frame === 'selected' ? session.getTargetContext() : null
	const node = context?.kind === 'frame' ? findFrame(frameTree, context.frameId) : frameTree
	const loaderId = node?.frame.loaderId
	return node && loaderId ? `${node.frame.id}:${loaderId}` : null
}

const findFrame = (node: CdpFrameTreeNode, frameId: string): CdpFrameTreeNode | null => {
	if (node.frame.id === frameId) return node
	for (const child of node.childFrames ?? []) {
		const found = findFrame(child, frameId)
		if (found) return found
	}
	return null
}
