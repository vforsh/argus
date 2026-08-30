import type { PopupWatcherStatus } from '../background/popup-protocol.js'

/**
 * Watcher info the popup copies to the clipboard.
 *
 * Split out of popup.ts with the health panel and the button-feedback state, which
 * together had pushed that file past 700 lines.
 */

export async function copyTextToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text)
		return
	} catch {
		// Chrome extension popups can lose Clipboard API access depending on focus/permission state.
	}

	const textarea = document.createElement('textarea')
	textarea.value = text
	textarea.setAttribute('readonly', 'true')
	textarea.style.position = 'fixed'
	textarea.style.opacity = '0'
	textarea.style.pointerEvents = 'none'
	document.body.appendChild(textarea)
	textarea.select()
	textarea.setSelectionRange(0, textarea.value.length)

	try {
		const copied = document.execCommand('copy')
		if (!copied) {
			throw new Error('Browser denied clipboard write')
		}
	} finally {
		textarea.remove()
	}
}

export function buildWatcherInfoText(watcher: PopupWatcherStatus | null): string | null {
	if (!canCopyWatcherInfo(watcher)) {
		return null
	}

	const readyWatcher = watcher!
	const target = readyWatcher.currentTarget!
	const attached = target.attachedAt ? new Date(target.attachedAt).toISOString() : new Date().toISOString()
	const fields = [
		['ID', readyWatcher.watcherId!],
		['Host', `${readyWatcher.watcherHost!}:${readyWatcher.watcherPort!}`],
		['PID', String(readyWatcher.nativeHostPid!)],
		['Target', target.title || '(no title)'],
		['URL', target.url || '(no url)'],
		['Attached', attached],
	]

	return `Argus Watcher Info\n${fields.map(([label, value]) => `${label}: ${value}`).join('\n')}`
}

export function buildAllWatchersInfoText(watchers: PopupWatcherStatus[]): string | null {
	const watcherInfo = watchers.map((watcher) => buildWatcherInfoText(watcher)).filter((text): text is string => Boolean(text))
	if (watcherInfo.length === 0) {
		return null
	}

	return watcherInfo.join('\n\n')
}

export function findWatcherByTabId(watchers: PopupWatcherStatus[], tabId: number): PopupWatcherStatus | null {
	return watchers.find((watcher) => watcher.tabId === tabId) ?? null
}

/** True when the watcher has everything the copied text needs. */
function canCopyWatcherInfo(watcher: PopupWatcherStatus | null | undefined): boolean {
	return Boolean(watcher?.watcherId && watcher?.watcherHost && watcher?.watcherPort != null && watcher?.nativeHostPid && watcher?.currentTarget)
}
