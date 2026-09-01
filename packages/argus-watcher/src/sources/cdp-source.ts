/**
 * CDP source for direct Chrome DevTools Protocol connection via WebSocket.
 * Wraps the existing CDP watcher with the unified source interface.
 */

import { formatError, type WatcherMatch, type WatcherChrome } from '@vforsh/argus-core'
import { startCdpWatcher, type CdpWatcherOptions, type CdpWatcherHandle } from '../cdp/watcher.js'
import { createCdpBrowserCookieReader } from '../cdp/browserCookies.js'
import { createCdpSessionHandle, type CdpSessionController } from '../cdp/connection.js'
import { CDP_HEALTH_PROBE_TIMEOUT_MS, type CdpTransportCheck } from '../cdp/health.js'
import { fetchCdpTargets } from '../cdp/watcherTargets.js'
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
	const { events, ignoreMatcher, stripUrlPrefixes, sourcemaps, chrome, match, sessionHandle } = options

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
		sourcemaps,
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
		pageSession: watcher.session,
		readBrowserCookies: createCdpBrowserCookieReader(chrome, () => watcher.getTarget()?.id ?? null),
		getNetFilterContext: () => {
			const target = watcher.getTarget()
			const context = watcher.session.getTargetContext()
			return {
				sourceMode: 'cdp',
				selectedFrameId: context?.kind === 'frame' ? context.frameId : null,
				topFrameId: null,
				selectedTargetUrl: target?.url ?? null,
				pageUrl: target?.url ?? null,
			}
		},
		healthChecks: {
			checkTransport: () => checkCdpTransport(chrome, watcher),
			onTargetGone: watcher.reconnect,
		},
		stop: watcher.stop,
		// CDP mode doesn't support listTargets/attachTarget/detachTarget
		// (auto-attaches based on match criteria)
	}
}

/**
 * Ask Chrome directly whether the browser and our target are still there.
 *
 * The WebSocket is a poor witness here: a renderer stranded by a cross-origin navigation leaves the
 * socket open and simply stops answering, so the only way to tell "browser gone" from "target
 * replaced" from "renderer wedged" is to read the target list out of band.
 */
const checkCdpTransport = async (chrome: WatcherChrome, watcher: CdpWatcherHandle): Promise<CdpTransportCheck> => {
	let targets
	try {
		targets = await fetchCdpTargets(chrome, CDP_HEALTH_PROBE_TIMEOUT_MS)
	} catch (error) {
		return { state: 'unreachable', detail: `${chrome.host}:${chrome.port}: ${formatError(error)}` }
	}

	const target = watcher.getTarget()
	if (!target) {
		return { state: 'target_gone', detail: 'the watcher holds no target' }
	}

	if (!targets.some((candidate) => candidate.id === target.id)) {
		return { state: 'target_gone', detail: `Chrome no longer lists target ${target.id} (${target.url})` }
	}

	return { state: 'ok' }
}
