/**
 * Pure frame-table bookkeeping for one attached tab.
 *
 * The extension owns the authoritative frame table (C2 redesign): these helpers mutate it
 * from real CDP events and from `Page.getFrameTree` snapshots, and never emit anything.
 * Publishing the table to the watcher (as a `frame_snapshot` bridge message) is the
 * caller's job — see `DebuggerManager.emitFramesChangedIfNeeded`.
 */

export type FrameRecord = {
	frameId: string
	parentFrameId: string | null
	url: string
	title: string | null
	sessionId: string | null
}

export type CdpFrameTreeNode = {
	frame?: { id?: string; parentId?: string; name?: string; url?: string }
	childFrames?: CdpFrameTreeNode[]
}

/** The slice of an attached target the frame helpers operate on. */
export type FrameTable = {
	frames: Map<string, FrameRecord>
	topFrameId: string | null
	url: string
}

/**
 * Merge a full `Page.getFrameTree` result for one session into the table, then prune
 * frames of the same session that no longer exist. Each result is a complete snapshot
 * for that session, so anything missing from it is gone after a reload.
 */
export const applyFrameTreeSnapshot = (table: FrameTable, sessionId: string | null, node: CdpFrameTreeNode | undefined): void => {
	if (!node?.frame?.id) {
		return
	}

	const nextFrameIds = new Set<string>()
	mergeFrameTree(table, sessionId, node, nextFrameIds)
	for (const [frameId, frame] of table.frames.entries()) {
		if (frame.sessionId === sessionId && !nextFrameIds.has(frameId)) {
			table.frames.delete(frameId)
		}
	}
}

const mergeFrameTree = (table: FrameTable, sessionId: string | null, node: CdpFrameTreeNode | undefined, nextFrameIds: Set<string>): void => {
	if (!node?.frame?.id) {
		return
	}

	const frameId = node.frame.id
	nextFrameIds.add(frameId)
	table.frames.set(frameId, toFrameRecord(node.frame, sessionId))

	if (!node.frame.parentId && !sessionId) {
		table.topFrameId = frameId
	}

	for (const child of node.childFrames ?? []) {
		mergeFrameTree(table, sessionId, child, nextFrameIds)
	}
}

/**
 * Apply one real CDP frame event to the table. Returns true when the event changed
 * frame state (so the caller knows a snapshot publish may be due).
 */
export const applyFrameEvent = (table: FrameTable, sessionId: string | null, method: string, params?: object): boolean => {
	if (method === 'Page.frameNavigated' && params) {
		const frame = (params as { frame?: { id?: string; parentId?: string | null; url?: string; name?: string } }).frame
		if (!frame?.id) {
			return false
		}

		table.frames.set(frame.id, toFrameRecord(frame, sessionId))

		if (!frame.parentId && !sessionId && frame.url) {
			table.url = frame.url
			table.topFrameId = frame.id
		}
		return true
	}

	if (method === 'Page.frameAttached' && params) {
		const frame = params as { frameId?: string; parentFrameId?: string }
		if (!frame.frameId) {
			return false
		}

		const existing = table.frames.get(frame.frameId)
		table.frames.set(frame.frameId, {
			frameId: frame.frameId,
			parentFrameId: frame.parentFrameId ?? table.topFrameId,
			url: existing?.url ?? '',
			title: existing?.title ?? null,
			sessionId: existing?.sessionId ?? sessionId,
		})
		return true
	}

	if (method === 'Page.frameDetached' && params) {
		const frame = params as { frameId?: string }
		if (!frame.frameId) {
			return false
		}

		return table.frames.delete(frame.frameId)
	}

	return false
}

/** Remove every frame owned by a detached child session. Returns true when any were removed. */
export const dropSessionFrames = (table: FrameTable, sessionId: string): boolean => {
	let removed = false
	for (const [frameId, frame] of table.frames.entries()) {
		if (frame.sessionId === sessionId) {
			table.frames.delete(frameId)
			removed = true
		}
	}
	return removed
}

/**
 * Stable serialization of the table used to deduplicate `frame_snapshot` publishes:
 * a resync that changed nothing must not generate bridge traffic.
 */
export const serializeFrameTable = (table: FrameTable): string => {
	const frames = [...table.frames.values()].sort((a, b) => a.frameId.localeCompare(b.frameId))
	return JSON.stringify({ topFrameId: table.topFrameId, frames })
}

const toFrameRecord = (frame: { id?: string; parentId?: string | null; url?: string; name?: string }, sessionId: string | null): FrameRecord => ({
	frameId: frame.id!,
	parentFrameId: frame.parentId ?? null,
	url: frame.url ?? '',
	title: frame.name ?? null,
	sessionId,
})
