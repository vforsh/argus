/**
 * CDP source for direct Chrome DevTools Protocol connection via WebSocket.
 * Wraps the existing CDP watcher with the unified source interface.
 */

import type { WatcherMatch, WatcherChrome } from '@vforsh/argus-core'
import { startCdpWatcher, type CdpWatcherOptions } from '../cdp/watcher.js'
import { createCdpSessionHandle, type CdpSessionController } from '../cdp/connection.js'
import type { IgnoreMatcher } from '../cdp/ignoreList.js'
import type { CdpSourceHandle, CdpSourceBaseOptions } from './types.js'

/**
 * Options for creating a CDP source.
 */
export type CdpSourceOptions = CdpSourceBaseOptions & {
	/** Chrome DevTools Protocol connection settings. */
	chrome: WatcherChrome
	/** Criteria for which Chrome target(s) to attach to. */
	match?: WatcherMatch
	/** Optional session controller (for sharing session handle with other components). */
	sessionHandle?: CdpSessionController
}

/**
 * Create a CDP source that connects to Chrome via WebSocket.
 * Returns a handle that can be used to control the source and access CDP session.
 */
export const createCdpSource = (options: CdpSourceOptions): CdpSourceHandle => {
	const { events, ignoreMatcher, stripUrlPrefixes, chrome, match, sessionHandle } = options

	// Create session handle if not provided
	const controller = sessionHandle ?? createCdpSessionHandle()

	// Convert ignoreMatcher function to IgnoreMatcher object if needed
	const ignoreMatcherObj: IgnoreMatcher | null = ignoreMatcher ? { matches: ignoreMatcher } : null

	// Map source events to watcher events
	const watcherOptions: CdpWatcherOptions = {
		chrome,
		match,
		sessionHandle: controller,
		ignoreMatcher: ignoreMatcherObj,
		stripUrlPrefixes,
		onLog: events.onLog,
		onStatus: events.onStatus,
		onPageNavigation: events.onPageNavigation,
		onPageLoad: events.onPageLoad,
		onPageIntl: events.onPageIntl,
		onAttach: events.onAttach
			? (session, target) =>
					events.onAttach!(session, {
						id: target.id,
						title: target.title,
						url: target.url,
						type: target.type,
						parentId: target.parentId,
					})
			: undefined,
		onDetach: events.onDetach,
	}

	const watcher = startCdpWatcher(watcherOptions)

	return {
		session: watcher.session,
		stop: watcher.stop,
		// CDP mode doesn't support listTargets/attachTarget/detachTarget
		// (auto-attaches based on match criteria)
	}
}
