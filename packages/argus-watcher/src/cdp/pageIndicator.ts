import type { CdpSessionHandle } from './connection.js'
import type { CdpTarget } from './watcher.js'

export type PageIndicatorPosition = 'left' | 'center' | 'right'

export type PageIndicatorOptions = {
	enabled?: boolean
	position?: PageIndicatorPosition
	heartbeatMs?: number
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
	onDetach: () => void
	stop: () => void
}

const BOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`

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
const DEFAULT_ICON_COLOR = 'rgba(255, 255, 255, 0.95)'
const DEFAULT_MARGIN = 8
const DEFAULT_SIZE = 19

export const createPageIndicatorController = (options: PageIndicatorOptions): PageIndicatorController => {
	const position = options.position ?? 'left'
	const heartbeatMs = options.heartbeatMs ?? 2000
	const ttlMs = options.ttlMs ?? 6000
	const bgColor = options.bgColor ?? DEFAULT_BG_COLOR
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

		void installIndicator(session, { info, position, ttlMs, bgColor, iconColor, margin, size })

		heartbeatTimer = setInterval(() => {
			if (!currentSession || !currentInfo) {
				return
			}
			void sendHeartbeat(currentSession, currentInfo)
		}, heartbeatMs)
	}

	const onNavigation = (session: CdpSessionHandle, info: PageIndicatorInfo): void => {
		currentInfo = info
		void installIndicator(session, { info, position, ttlMs, bgColor, iconColor, margin, size })
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

	return { onAttach, onNavigation, onDetach, stop }
}

const installIndicator = async (
	session: CdpSessionHandle,
	params: {
		info: PageIndicatorInfo
		position: PageIndicatorPosition
		ttlMs: number
		bgColor: string
		iconColor: string
		margin: number
		size: number
	},
): Promise<void> => {
	const { info, position, ttlMs, bgColor, iconColor, margin, size } = params
	const expression = buildInstallExpression({ info, position, ttlMs, bgColor, iconColor, margin, size })

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

const buildInstallExpression = (params: {
	info: PageIndicatorInfo
	position: PageIndicatorPosition
	ttlMs: number
	bgColor: string
	iconColor: string
	margin: number
	size: number
}): string => {
	const { info, position, ttlMs, bgColor, iconColor, margin, size } = params
	const infoJson = JSON.stringify(info)
	const svgWithSize = BOT_SVG.replace(/width="19"/, `width="${size}"`).replace(/height="19"/, `height="${size}"`)
	const svgEscaped = svgWithSize.replace(/'/g, "\\'")

	const positionStyles: Record<PageIndicatorPosition, string> = {
		left: `left: ${margin}px;`,
		center: 'left: 50%; transform: translateX(-50%);',
		right: `right: ${margin}px;`,
	}

	const posStyle = positionStyles[position]
	const tooltipText = `Argus Watcher: ${info.watcherId}`

	return `
(function() {
  var INDICATOR_ID = 'argus-watcher-indicator';
  var STATE_KEY = '__ARGUS_WATCHER_INDICATOR__';
  var info = ${infoJson};
  var ttlMs = ${ttlMs};
  var svg = '${svgEscaped}';

  var existing = document.getElementById(INDICATOR_ID);
  if (existing) {
    existing.remove();
  }

  if (window[STATE_KEY] && window[STATE_KEY].timerId) {
    clearInterval(window[STATE_KEY].timerId);
  }

  var el = document.createElement('div');
  el.id = INDICATOR_ID;
  el.setAttribute('data-testid', INDICATOR_ID);
  el.setAttribute('title', '${tooltipText}');
  el.style.cssText = 'position: fixed; bottom: ${margin}px; ${posStyle} z-index: 2147483647; ' +
    'background: ${bgColor}; color: ${iconColor}; ' +
    'padding: 6px; border-radius: 6px; ' +
    'cursor: pointer; display: flex; align-items: center; justify-content: center; ' +
    'user-select: none; pointer-events: auto;';
  el.innerHTML = svg;

  el.addEventListener('click', function() {
    var state = window[STATE_KEY];
    var i = state ? state.info : info;
    var attachedDate = new Date(i.attachedAt).toISOString();
    alert(
      'Argus Watcher Info\\n\\n' +
      'ID: ' + i.watcherId + '\\n' +
      'Host: ' + i.watcherHost + ':' + i.watcherPort + '\\n' +
      'PID: ' + i.watcherPid + '\\n' +
      'Target: ' + (i.targetTitle || '(no title)') + '\\n' +
      'URL: ' + (i.targetUrl || '(no url)') + '\\n' +
      'Attached: ' + attachedDate
    );
  });

  document.documentElement.appendChild(el);

  var timerId = setInterval(function() {
    var state = window[STATE_KEY];
    if (!state) {
      clearInterval(timerId);
      var indicator = document.getElementById(INDICATOR_ID);
      if (indicator) indicator.remove();
      return;
    }
    if (Date.now() - state.lastSeenMs > state.ttlMs) {
      clearInterval(state.timerId);
      var indicator = document.getElementById(INDICATOR_ID);
      if (indicator) indicator.remove();
      delete window[STATE_KEY];
    }
  }, 1000);

  window[STATE_KEY] = {
    lastSeenMs: Date.now(),
    ttlMs: ttlMs,
    timerId: timerId,
    info: info
  };
})();
`
}

const buildHeartbeatExpression = (info: PageIndicatorInfo): string => {
	const infoJson = JSON.stringify(info)

	return `
(function() {
  var STATE_KEY = '__ARGUS_WATCHER_INDICATOR__';
  var state = window[STATE_KEY];
  if (state) {
    state.lastSeenMs = Date.now();
    state.info = ${infoJson};
  }
})();
`
}

const buildRemoveExpression = (): string => {
	return `
(function() {
  var INDICATOR_ID = 'argus-watcher-indicator';
  var STATE_KEY = '__ARGUS_WATCHER_INDICATOR__';
  var state = window[STATE_KEY];
  if (state && state.timerId) {
    clearInterval(state.timerId);
  }
  delete window[STATE_KEY];
  var el = document.getElementById(INDICATOR_ID);
  if (el) el.remove();
})();
`
}
