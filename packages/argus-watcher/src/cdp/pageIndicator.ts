import type { CdpSessionHandle } from './connection.js'
import { buildHeartbeatExpression, buildInstallExpression, buildRemoveExpression } from './pageIndicatorScript.js'
import type { CdpTarget } from './watcherTargets.js'

export type PageIndicatorPosition =
	| 'top-left'
	| 'top-center'
	| 'top-right'
	| 'bottom-left'
	| 'bottom-center'
	| 'bottom-right'
	| 'left-center'
	| 'right-center'

export type PageIndicatorOptions = {
	/** Whether the in-page indicator is enabled. */
	enabled?: boolean
	/** The predefined position of the indicator on the page. */
	position?: PageIndicatorPosition
	/** The interval in milliseconds at which the watcher sends a heartbeat to keep the indicator alive. */
	heartbeatMs?: number
	/** The time-to-live in milliseconds for the indicator. If no heartbeat is received within this time, the indicator is removed from the page. */
	ttlMs?: number
	/** Background color for the indicator badge. Defaults to 'rgba(0, 0, 0, 0.75)'. */
	bgColor?: string
	/** Icon color for the indicator badge. Defaults to 'rgba(255, 255, 255, 0.95)'. */
	iconColor?: string
	/** Margin from the edge in pixels. Defaults to 8. */
	margin?: number
	/** Icon size in pixels. Defaults to 19. */
	size?: number
}

export type PageIndicatorInfo = {
	watcherId: string
	watcherHost: string
	watcherPort: number
	watcherPid: number
	targetTitle: string | null
	targetUrl: string | null
	attachedAt: number
}

export type PageIndicatorController = {
	onAttach: (session: CdpSessionHandle, target: CdpTarget, info: PageIndicatorInfo) => void
	onNavigation: (session: CdpSessionHandle, info: PageIndicatorInfo) => void
	/** Re-inject the indicator using the last known info. Use after DOM is rebuilt (e.g. domContentEventFired). */
	reinstall: () => void
	onDetach: () => void
	stop: () => void
}

const MIN_HEARTBEAT_MS = 500
const MIN_TTL_MS = 2000

export const validatePageIndicatorOptions = (options: PageIndicatorOptions | undefined): void => {
	if (!options) {
		return
	}

	if (options.heartbeatMs !== undefined) {
		if (!Number.isInteger(options.heartbeatMs) || options.heartbeatMs < MIN_HEARTBEAT_MS) {
			throw new Error(`pageIndicator.heartbeatMs must be an integer >= ${MIN_HEARTBEAT_MS}`)
		}
	}

	if (options.ttlMs !== undefined) {
		if (!Number.isInteger(options.ttlMs) || options.ttlMs < MIN_TTL_MS) {
			throw new Error(`pageIndicator.ttlMs must be an integer >= ${MIN_TTL_MS}`)
		}
	}
}

const DEFAULT_BG_COLOR = 'rgba(0, 0, 0, 0.75)'
const DEFAULT_HOVER_BG_COLOR = 'rgba(0, 0, 0, 0.9)'
const DEFAULT_ICON_COLOR = 'rgba(255, 255, 255, 0.95)'
const DEFAULT_MARGIN = 8
const DEFAULT_SIZE = 19
export const createPageIndicatorController = (options: PageIndicatorOptions): PageIndicatorController => {
	const position = options.position ?? 'bottom-right'
	const heartbeatMs = options.heartbeatMs ?? 2000
	const ttlMs = options.ttlMs ?? 6000
	const bgColor = options.bgColor ?? DEFAULT_BG_COLOR
	const hoverBgColor = DEFAULT_HOVER_BG_COLOR
	const iconColor = options.iconColor ?? DEFAULT_ICON_COLOR
	const margin = options.margin ?? DEFAULT_MARGIN
	const size = options.size ?? DEFAULT_SIZE
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null
	let currentSession: CdpSessionHandle | null = null
	let currentInfo: PageIndicatorInfo | null = null

	const onAttach = (session: CdpSessionHandle, _target: CdpTarget, info: PageIndicatorInfo): void => {
		stop()
		currentSession = session
		currentInfo = info

		void installIndicator(session, {
			info,
			position,
			ttlMs,
			bgColor,
			hoverBgColor,
			iconColor,
			margin,
			size,
		})

		heartbeatTimer = setInterval(() => {
			if (!currentSession || !currentInfo) {
				return
			}
			void sendHeartbeat(currentSession, currentInfo)
		}, heartbeatMs)
	}

	const onNavigation = (session: CdpSessionHandle, info: PageIndicatorInfo): void => {
		currentInfo = info
		void installIndicator(session, {
			info,
			position,
			ttlMs,
			bgColor,
			hoverBgColor,
			iconColor,
			margin,
			size,
		})
	}

	const reinstall = (): void => {
		if (!currentSession || !currentInfo) {
			return
		}
		void installIndicator(currentSession, {
			info: currentInfo,
			position,
			ttlMs,
			bgColor,
			hoverBgColor,
			iconColor,
			margin,
			size,
		})
	}

	const onDetach = (): void => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer)
			heartbeatTimer = null
		}

		if (currentSession) {
			void removeIndicator(currentSession).catch(() => {})
		}

		currentSession = null
		currentInfo = null
	}

	const stop = (): void => {
		onDetach()
	}

	return { onAttach, onNavigation, reinstall, onDetach, stop }
}

const installIndicator = async (
	session: CdpSessionHandle,
	params: {
		info: PageIndicatorInfo
		position: PageIndicatorPosition
		ttlMs: number
		bgColor: string
		hoverBgColor: string
		iconColor: string
		margin: number
		size: number
	},
): Promise<void> => {
	const { info, position, ttlMs, bgColor, hoverBgColor, iconColor, margin, size } = params
	const expression = buildInstallExpression({
		info,
		position,
		ttlMs,
		bgColor,
		hoverBgColor,
		iconColor,
		margin,
		size,
	})

	try {
		await session.sendAndWait('Runtime.evaluate', {
			expression,
			returnByValue: true,
		})
	} catch {
		// Best-effort; page may not be ready
	}
}

const sendHeartbeat = async (session: CdpSessionHandle, info: PageIndicatorInfo): Promise<void> => {
	const expression = buildHeartbeatExpression(info)

	try {
		await session.sendAndWait('Runtime.evaluate', {
			expression,
			returnByValue: true,
		})
	} catch {
		// Best-effort; CDP may be disconnected
	}
}

const removeIndicator = async (session: CdpSessionHandle): Promise<void> => {
	const expression = buildRemoveExpression()

	try {
		await session.sendAndWait('Runtime.evaluate', {
			expression,
			returnByValue: true,
		})
	} catch {
		// Best-effort; CDP may be unavailable
	}
}
