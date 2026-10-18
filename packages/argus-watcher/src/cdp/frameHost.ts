import type { WatcherChrome } from '@vforsh/argus-core'
import { openCdpConnection, type CdpSessionHandle, type OneShotCdpConnection } from './connection.js'
import { quadToRect } from './visualCapture.js'
import { fetchCdpTargets, type CdpTarget } from './watcherTargets.js'

export type FrameRect = { x: number; y: number; width: number; height: number }

/**
 * The top-level page that renders an out-of-process iframe target, borrowed for visual capture.
 *
 * Chrome accepts `Page.captureScreenshot` and `Page.startScreencast` only on top-level targets, and a
 * direct-CDP watcher matched to a cross-site iframe owns nothing else. The pixels belong to the
 * parent page, so capture opens its own connection to that page, scrolls the iframe into view, and crops to it —
 * the same thing extension mode does with its tab-level session.
 */
export type FrameHost = {
	/** Connection to the top-level page target. Valid until {@link FrameHost.close}. */
	session: CdpSessionHandle
	/** The iframe's content box in the top-level page's viewport, in CSS pixels. */
	frameRect: FrameRect
	close: () => void
}

/**
 * Open the top-level page that hosts `target` and locate the iframe inside it.
 *
 * Nested out-of-process iframes are walked one parent at a time: each hop's frame owner is measured
 * in its parent's viewport, and the offsets add up to the position in the top-level viewport.
 */
export const openFrameHost = async (chrome: WatcherChrome, target: CdpTarget): Promise<FrameHost> => {
	const chain = resolveParentChain(target, await fetchCdpTargets(chrome))
	const connections: OneShotCdpConnection[] = []

	try {
		const ownerRects: FrameRect[] = []
		let child = target
		for (const parent of chain) {
			const connection = await openCdpConnection(parent.webSocketDebuggerUrl)
			connections.push(connection)
			ownerRects.push(await resolveFrameOwnerRect(connection.session, child.id))
			child = parent
		}

		// The innermost owner gives the size; every hop contributes its offset.
		const frameRect = ownerRects.slice(1).reduce((rect, outer) => ({ ...rect, x: rect.x + outer.x, y: rect.y + outer.y }), ownerRects[0])
		const top = connections.pop()!
		closeAll(connections)
		return { session: top.session, frameRect, close: top.close }
	} catch (error) {
		closeAll(connections)
		throw error
	}
}

const PAGE_WATCHER_HINT = 'Screenshot a watcher attached to the top-level page instead (argus watcher start --type page).'

/** Parents of `target`, nearest first, ending at the top-level page. */
const resolveParentChain = (target: CdpTarget, targets: CdpTarget[]): CdpTarget[] => {
	const byId = new Map(targets.map((candidate) => [candidate.id, candidate]))
	const chain: CdpTarget[] = []
	let current = target

	while (current.parentId) {
		const parent = byId.get(current.parentId)
		if (!parent) {
			throw new Error(`Cannot capture iframe target ${target.id}: its parent target ${current.parentId} is not listed by Chrome. ${PAGE_WATCHER_HINT}`)
		}
		if (chain.includes(parent)) {
			throw new Error(`Cannot capture iframe target ${target.id}: its parent chain loops at ${parent.id}`)
		}
		chain.push(parent)
		current = parent
	}

	if (chain.length === 0) {
		throw new Error(`Cannot capture iframe target ${target.id}: Chrome reports no parent page for it. ${PAGE_WATCHER_HINT}`)
	}

	return chain
}

/** The iframe element's content box, viewport-relative in the document that owns it. */
const resolveFrameOwnerRect = async (session: CdpSessionHandle, frameId: string): Promise<FrameRect> => {
	// An out-of-process iframe target's id is its frame id.
	const owner = await session.sendAndWait('DOM.getFrameOwner', { frameId })
	if (owner.backendNodeId == null && owner.nodeId == null) {
		throw new Error(`Unable to resolve iframe owner for frame: ${frameId}`)
	}

	const node = owner.nodeId != null ? { nodeId: owner.nodeId } : { backendNodeId: owner.backendNodeId }
	// A crop outside the viewport captures nothing, and Chrome does not paint offscreen iframes at all.
	await session.sendAndWait('DOM.scrollIntoViewIfNeeded', node)
	const box = await session.sendAndWait('DOM.getBoxModel', node)
	const quad = box.model?.content
	if (!quad || quad.length < 8) {
		throw new Error(`Unable to compute iframe box model for frame: ${frameId}`)
	}

	const rect = quadToRect(quad)
	if (rect.width <= 0 || rect.height <= 0) {
		throw new Error(`Iframe for frame ${frameId} has zero area`)
	}

	return rect
}

const closeAll = (connections: OneShotCdpConnection[]): void => {
	for (const connection of connections) {
		connection.close()
	}
}
