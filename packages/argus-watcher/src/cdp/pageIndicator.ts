import type { CdpSessionHandle } from './connection.js'
import type { CdpTarget } from './watcher.js'

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

const buildInstallExpression = (params: {
	info: PageIndicatorInfo
	position: PageIndicatorPosition
	ttlMs: number
	bgColor: string
	hoverBgColor: string
	iconColor: string
	margin: number
	size: number
}): string => {
	const { info, position, ttlMs, bgColor, hoverBgColor, iconColor, margin, size } = params
	const infoJson = JSON.stringify(info)
	const svgWithSize = BOT_SVG.replace(/width="19"/, `width="${size}"`).replace(/height="19"/, `height="${size}"`)
	const svgEscaped = svgWithSize.replace(/'/g, "\\'")

	const positionStyles: Record<PageIndicatorPosition, string> = {
		'top-left': `top: ${margin}px; left: ${margin}px;`,
		'top-center': `top: ${margin}px; left: 50%; transform: translateX(-50%);`,
		'top-right': `top: ${margin}px; right: ${margin}px;`,
		'bottom-left': `bottom: ${margin}px; left: ${margin}px;`,
		'bottom-center': `bottom: ${margin}px; left: 50%; transform: translateX(-50%);`,
		'bottom-right': `bottom: ${margin}px; right: ${margin}px;`,
		'left-center': `top: 50%; left: ${margin}px; transform: translateY(-50%);`,
		'right-center': `top: 50%; right: ${margin}px; transform: translateY(-50%);`,
	}

	const posStyle = positionStyles[position]
	const tooltipText = `Argus Watcher: ${info.watcherId}`

	return `
(function() {
  var INDICATOR_ID = 'argus-watcher-indicator';
  var STYLE_ID = 'argus-watcher-indicator-style';
  var DIALOG_ID = 'argus-watcher-indicator-dialog';
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

  // Inject styles for hover effects and dialog
  var existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) {
    existingStyle.remove();
  }
  var style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    '#' + INDICATOR_ID + ' {' +
      'transition: filter 0.15s ease, background 0.15s ease;' +
    '}' +
    '#' + INDICATOR_ID + ':hover {' +
      'filter: brightness(1.4);' +
      'background: ${hoverBgColor} !important;' +
    '}' +
    '#' + DIALOG_ID + '::backdrop {' +
      'background: rgba(0, 0, 0, 0.5);' +
    '}' +
    '#' + DIALOG_ID + ' {' +
      'border: 1px solid rgba(255, 255, 255, 0.15);' +
      'border-radius: 10px;' +
      'background: #1a1a1a;' +
      'color: #e0e0e0;' +
      'padding: 0;' +
      'min-width: 320px;' +
      'max-width: 480px;' +
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      'font-size: 13px;' +
      'box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);' +
    '}' +
    '#' + DIALOG_ID + ' .argus-dialog-header {' +
      'padding: 14px 18px 10px;' +
      'font-size: 14px;' +
      'font-weight: 600;' +
      'color: #fff;' +
      'border-bottom: 1px solid rgba(255, 255, 255, 0.1);' +
    '}' +
    '#' + DIALOG_ID + ' .argus-dialog-body {' +
      'padding: 12px 18px;' +
    '}' +
    '#' + DIALOG_ID + ' .argus-dialog-row {' +
      'display: flex;' +
      'padding: 4px 0;' +
      'gap: 12px;' +
    '}' +
    '#' + DIALOG_ID + ' .argus-dialog-label {' +
      'flex-shrink: 0;' +
      'width: 70px;' +
      'color: rgba(255, 255, 255, 0.5);' +
      'font-size: 12px;' +
      'text-transform: uppercase;' +
      'letter-spacing: 0.5px;' +
      'padding-top: 1px;' +
    '}' +
    '#' + DIALOG_ID + ' .argus-dialog-value {' +
      'color: #e0e0e0;' +
      'word-break: break-all;' +
    '}' +
    '#' + DIALOG_ID + ' .argus-dialog-footer {' +
      'display: flex;' +
      'justify-content: flex-end;' +
      'gap: 8px;' +
      'padding: 10px 18px 14px;' +
      'border-top: 1px solid rgba(255, 255, 255, 0.1);' +
    '}' +
    '#' + DIALOG_ID + ' button {' +
      'border: 1px solid rgba(255, 255, 255, 0.2);' +
      'border-radius: 6px;' +
      'padding: 6px 16px;' +
      'font-size: 13px;' +
      'cursor: pointer;' +
      'background: rgba(255, 255, 255, 0.08);' +
      'color: #e0e0e0;' +
    '}' +
    '#' + DIALOG_ID + ' button:hover {' +
      'background: rgba(255, 255, 255, 0.15);' +
    '}';
  document.documentElement.appendChild(style);

  var el = document.createElement('div');
  el.id = INDICATOR_ID;
  el.setAttribute('data-testid', INDICATOR_ID);
  el.setAttribute('title', '${tooltipText}');
  el.style.cssText = 'position: fixed; ${posStyle} z-index: 2147483647; ' +
    'background: ${bgColor}; color: ${iconColor}; ' +
    'padding: 6px; border-radius: 6px; ' +
    'cursor: pointer; display: flex; align-items: center; justify-content: center; ' +
    'user-select: none; pointer-events: auto;';
  el.innerHTML = svg;

  el.addEventListener('click', function() {
    var state = window[STATE_KEY];
    var i = state ? state.info : info;
    var attachedDate = new Date(i.attachedAt).toISOString();
    var fields = [
      ['ID', i.watcherId],
      ['Host', i.watcherHost + ':' + i.watcherPort],
      ['PID', String(i.watcherPid)],
      ['Target', i.targetTitle || '(no title)'],
      ['URL', i.targetUrl || '(no url)'],
      ['Attached', attachedDate]
    ];

    var dialog = document.getElementById(DIALOG_ID);
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = DIALOG_ID;
      dialog.addEventListener('click', function(e) {
        if (e.target === dialog) {
          dialog.close();
        }
      });
      document.documentElement.appendChild(dialog);
    }

    var html = '<div class="argus-dialog-header">Argus Watcher</div>' +
      '<div class="argus-dialog-body">';
    for (var f = 0; f < fields.length; f++) {
      html += '<div class="argus-dialog-row">' +
        '<span class="argus-dialog-label">' + fields[f][0] + '</span>' +
        '<span class="argus-dialog-value">' + fields[f][1] + '</span>' +
        '</div>';
    }
    html += '</div>' +
      '<div class="argus-dialog-footer">' +
        '<button data-action="copy" type="button">Copy</button>' +
        '<button data-action="close" type="button">Close</button>' +
      '</div>';
    dialog.innerHTML = html;

    dialog.querySelector('[data-action="copy"]').addEventListener('click', function() {
      var text = 'Argus Watcher Info\\n';
      for (var c = 0; c < fields.length; c++) {
        text += fields[c][0] + ': ' + fields[c][1] + '\\n';
      }
      navigator.clipboard.writeText(text.trim()).then(function() {
        var btn = dialog.querySelector('[data-action="copy"]');
        if (btn) {
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
        }
      });
    });

    dialog.querySelector('[data-action="close"]').addEventListener('click', function() {
      dialog.close();
    });

    dialog.showModal();
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
  var STYLE_ID = 'argus-watcher-indicator-style';
  var DIALOG_ID = 'argus-watcher-indicator-dialog';
  var STATE_KEY = '__ARGUS_WATCHER_INDICATOR__';
  var state = window[STATE_KEY];
  if (state && state.timerId) {
    clearInterval(state.timerId);
  }
  delete window[STATE_KEY];
  var el = document.getElementById(INDICATOR_ID);
  if (el) el.remove();
  var styleEl = document.getElementById(STYLE_ID);
  if (styleEl) styleEl.remove();
  var dialogEl = document.getElementById(DIALOG_ID);
  if (dialogEl) dialogEl.remove();
})();
`
}
