import type { PageIndicatorInfo, PageIndicatorPosition } from './pageIndicator.js'

type InstallExpressionParams = {
	info: PageIndicatorInfo
	position: PageIndicatorPosition
	ttlMs: number
	bgColor: string
	hoverBgColor: string
	iconColor: string
	margin: number
	size: number
}

const ICONS = {
	bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
	copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
} as const

const COPY_ICON_SIZE = 15
const INFO_REVEAL_DELAY_MS = 1500
const INFO_REVEAL_DURATION_MS = 100
const INFO_BUTTON_GAP_PX = 3
const MAIN_FEEDBACK_MS = 1400
const DIALOG_COPY_FEEDBACK_MS = 1500
const INFO_VISIBLE_CLASS = 'argus-indicator-info-visible'
const INDICATOR_BUTTON_TRANSITION_PROPS = ['background', 'border-color', 'filter', 'opacity', 'transform']

/** Build the page-side installer script that owns all indicator DOM, events, and clipboard feedback. */
export const buildInstallExpression = (params: InstallExpressionParams): string => {
	const { info, position, ttlMs, bgColor, hoverBgColor, iconColor, margin, size } = params
	const iconJson = JSON.stringify(ICONS)
	const infoJson = JSON.stringify(info)
	const positionStyle = resolvePositionStyle(position, margin)
	const tooltipText = JSON.stringify(`Argus Watcher: ${info.watcherId}`)
	const buttonSize = size + 12
	const buttonTransition = buildTransition(INDICATOR_BUTTON_TRANSITION_PROPS, INFO_REVEAL_DURATION_MS)

	return `
(function() {
  var INDICATOR_ID = 'argus-watcher-indicator';
  var STYLE_ID = 'argus-watcher-indicator-style';
  var DIALOG_ID = 'argus-watcher-indicator-dialog';
  var STATE_KEY = '__ARGUS_WATCHER_INDICATOR__';
  var INFO_VISIBLE_CLASS = '${INFO_VISIBLE_CLASS}';
  var ICONS = ${iconJson};
  var info = ${infoJson};
  var ttlMs = ${ttlMs};
  var isHovering = false;
  var infoVisible = false;
  var infoRevealTimer = null;
  var feedbackTimer = null;

  removeExistingIndicator();
  installStyle();

  var wrapper = document.createElement('div');
  wrapper.id = INDICATOR_ID;
  wrapper.setAttribute('data-testid', INDICATOR_ID);

  var mainButton = createIconButton('argus-indicator-main', 'Argus watcher: copy info', ${tooltipText}, 'bot');
  var infoButton = createIconButton('argus-indicator-info', 'Argus watcher details', 'Watcher details', 'info');
  wrapper.appendChild(mainButton);
  wrapper.appendChild(infoButton);

  // Delay starts on the main button only; once revealed, the info button stays clickable until the whole indicator is left.
  wrapper.addEventListener('mouseleave', function() {
    setInfoVisible(false);
  });
  mainButton.addEventListener('mouseenter', function() {
    isHovering = true;
    scheduleInfoReveal();
    if (!feedbackTimer) setMainIcon('copy');
  });
  mainButton.addEventListener('mouseleave', function() {
    isHovering = false;
    cancelInfoReveal();
    if (!feedbackTimer) setMainIcon('bot');
  });
  mainButton.addEventListener('click', function() {
    copyWatcherInfo().then(function() {
      showMainFeedback('check');
    }).catch(function() {
      showMainFeedback('error');
    });
  });
  infoButton.addEventListener('click', function(event) {
    event.stopPropagation();
    openWatcherDialog();
  });

  document.documentElement.appendChild(wrapper);

  var timerId = setInterval(function() {
    var state = window[STATE_KEY];
    if (!state) {
      clearInterval(timerId);
      removeExistingIndicator();
      return;
    }
    if (Date.now() - state.lastSeenMs > state.ttlMs) {
      clearInterval(state.timerId);
      removeExistingIndicator();
      delete window[STATE_KEY];
    }
  }, 1000);

  window[STATE_KEY] = {
    lastSeenMs: Date.now(),
    ttlMs: ttlMs,
    timerId: timerId,
    info: info
  };

  function installStyle() {
    var existingStyle = document.getElementById(STYLE_ID);
    if (existingStyle) existingStyle.remove();

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#' + INDICATOR_ID + ' {' +
        'position: fixed; ${positionStyle} z-index: 2147483647; display: flex; align-items: center; justify-content: center; gap: 0px; ' +
        'color: ${iconColor}; user-select: none; pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '}' +
      '#' + INDICATOR_ID + ' .argus-indicator-button {' +
        'width: ${buttonSize}px; height: ${buttonSize}px; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.12); ' +
        'border-radius: 7px; padding: 6px; display: flex; align-items: center; justify-content: center; color: ${iconColor}; ' +
        'background: ${bgColor}; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.22); cursor: pointer; transition: ${buttonTransition};' +
      '}' +
      '#' + INDICATOR_ID + ' .argus-indicator-button:hover {' +
        'background: ${hoverBgColor}; border-color: rgba(255, 255, 255, 0.22); filter: brightness(1.15);' +
      '}' +
      '#' + INDICATOR_ID + ' .argus-indicator-button svg {' +
        'max-width: ${size}px; max-height: ${size}px; flex: 0 0 auto; display: block;' +
      '}' +
      '#' + INDICATOR_ID + ' .argus-indicator-info {' +
        'position: absolute; right: 0; bottom: calc(100% + ${INFO_BUTTON_GAP_PX}px); opacity: 0; pointer-events: none; transform: translateY(2px);' +
      '}' +
      '#' + INDICATOR_ID + ' .argus-indicator-info-visible {' +
        'opacity: 1; pointer-events: auto; transform: translateY(0);' +
      '}' +
      '#' + DIALOG_ID + '::backdrop { background: rgba(0, 0, 0, 0.5); }' +
      '#' + DIALOG_ID + ' {' +
        'border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 10px; background: #1a1a1a; color: #e0e0e0; padding: 0; ' +
        'min-width: 320px; max-width: 480px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);' +
      '}' +
      '#' + DIALOG_ID + ' .argus-dialog-header { padding: 14px 18px 10px; font-size: 14px; font-weight: 600; color: #fff; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }' +
      '#' + DIALOG_ID + ' .argus-dialog-body { padding: 12px 18px; }' +
      '#' + DIALOG_ID + ' .argus-dialog-row { display: flex; padding: 4px 0; gap: 12px; }' +
      '#' + DIALOG_ID + ' .argus-dialog-label { flex-shrink: 0; width: 70px; color: rgba(255, 255, 255, 0.5); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding-top: 1px; }' +
      '#' + DIALOG_ID + ' .argus-dialog-value { color: #e0e0e0; word-break: break-all; }' +
      '#' + DIALOG_ID + ' .argus-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 18px 14px; border-top: 1px solid rgba(255, 255, 255, 0.1); }' +
      '#' + DIALOG_ID + ' button { border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer; background: rgba(255, 255, 255, 0.08); color: #e0e0e0; }' +
      '#' + DIALOG_ID + ' button:hover { background: rgba(255, 255, 255, 0.15); }';
    document.documentElement.appendChild(style);
  }

  function createIconButton(className, ariaLabel, title, iconName) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'argus-indicator-button ' + className;
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('title', title);
    button.innerHTML = renderIcon(iconName);
    return button;
  }

  function setMainIcon(iconName) {
    mainButton.innerHTML = renderIcon(iconName);
  }

  function scheduleInfoReveal() {
    cancelInfoReveal();
    if (infoVisible) return;
    infoRevealTimer = setTimeout(function() {
      infoRevealTimer = null;
      setInfoVisible(true);
    }, ${INFO_REVEAL_DELAY_MS});
  }

  function cancelInfoReveal() {
    if (!infoRevealTimer) return;
    clearTimeout(infoRevealTimer);
    infoRevealTimer = null;
  }

  function setInfoVisible(visible) {
    if (!visible) cancelInfoReveal();
    infoVisible = visible;
    infoButton.classList.toggle(INFO_VISIBLE_CLASS, visible);
  }

  function showMainFeedback(iconName) {
    if (feedbackTimer) clearTimeout(feedbackTimer);
    setMainIcon(iconName);
    feedbackTimer = setTimeout(function() {
      feedbackTimer = null;
      setMainIcon(isHovering ? 'copy' : 'bot');
    }, ${MAIN_FEEDBACK_MS});
  }

  function openWatcherDialog() {
    var fields = getWatcherFields();
    var dialog = document.getElementById(DIALOG_ID);
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = DIALOG_ID;
      dialog.addEventListener('click', function(e) {
        if (e.target === dialog) dialog.close();
      });
      document.documentElement.appendChild(dialog);
    }

    var html = '<div class="argus-dialog-header">Argus Watcher</div><div class="argus-dialog-body">';
    for (var f = 0; f < fields.length; f++) {
      html += '<div class="argus-dialog-row">' +
        '<span class="argus-dialog-label">' + escapeHtml(fields[f][0]) + '</span>' +
        '<span class="argus-dialog-value">' + escapeHtml(fields[f][1]) + '</span>' +
        '</div>';
    }
    html += '</div><div class="argus-dialog-footer">' +
      '<button data-action="copy" type="button">Copy</button>' +
      '<button data-action="close" type="button">Close</button>' +
      '</div>';
    dialog.innerHTML = html;

    dialog.querySelector('[data-action="copy"]').addEventListener('click', function() {
      copyWatcherInfo().then(function() {
        var btn = dialog.querySelector('[data-action="copy"]');
        if (btn) {
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy'; }, ${DIALOG_COPY_FEEDBACK_MS});
        }
      });
    });
    dialog.querySelector('[data-action="close"]').addEventListener('click', function() {
      dialog.close();
    });
    dialog.showModal();
  }

  function copyWatcherInfo() {
    return copyText(buildWatcherInfoText());
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function() {
        return copyTextFallback(text);
      });
    }
    return copyTextFallback(text);
  }

  function copyTextFallback(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position: fixed; left: -9999px; top: 0; opacity: 0;';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      if (!document.execCommand('copy')) throw new Error('copy command denied');
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      textarea.remove();
    }
  }

  function buildWatcherInfoText() {
    var fields = getWatcherFields();
    var text = 'Argus Watcher Info\\n';
    for (var i = 0; i < fields.length; i++) {
      text += fields[i][0] + ': ' + fields[i][1] + '\\n';
    }
    return text.trim();
  }

  function getWatcherFields() {
    var state = window[STATE_KEY];
    var i = state ? state.info : info;
    return [
      ['ID', i.watcherId],
      ['Host', i.watcherHost + ':' + i.watcherPort],
      ['PID', String(i.watcherPid)],
      ['Target', i.targetTitle || '(no title)'],
      ['URL', i.targetUrl || '(no url)'],
      ['Attached', new Date(i.attachedAt).toISOString()]
    ];
  }

  function renderIcon(iconName) {
    var iconSize = iconName === 'copy' ? '${COPY_ICON_SIZE}' : '${size}';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + iconSize + '" height="' + iconSize + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[iconName] + '</svg>';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function(char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function removeExistingIndicator() {
    var existing = document.getElementById(INDICATOR_ID);
    if (existing) existing.remove();
    if (window[STATE_KEY] && window[STATE_KEY].timerId) clearInterval(window[STATE_KEY].timerId);
  }
})();
`
}

/** Build a cheap page-side heartbeat update; the installed script keeps the DOM and TTL timer. */
export const buildHeartbeatExpression = (info: PageIndicatorInfo): string => {
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

/** Build the cleanup script used on watcher detach/stop. */
export const buildRemoveExpression = (): string => {
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

const buildTransition = (properties: readonly string[], durationMs: number): string =>
	properties.map((property) => `${property} ${durationMs}ms ease`).join(', ')

const resolvePositionStyle = (position: PageIndicatorPosition, margin: number): string => {
	const styles: Record<PageIndicatorPosition, string> = {
		'top-left': `top: ${margin}px; left: ${margin}px;`,
		'top-center': `top: ${margin}px; left: 50%; transform: translateX(-50%);`,
		'top-right': `top: ${margin}px; right: ${margin}px;`,
		'bottom-left': `bottom: ${margin}px; left: ${margin}px;`,
		'bottom-center': `bottom: ${margin}px; left: 50%; transform: translateX(-50%);`,
		'bottom-right': `bottom: ${margin}px; right: ${margin}px;`,
		'left-center': `top: 50%; left: ${margin}px; transform: translateY(-50%);`,
		'right-center': `top: 50%; right: ${margin}px; transform: translateY(-50%);`,
	}
	return styles[position]
}
