import type { PopupCurrentTarget, PopupStatusPayload, PopupWatcherStatus } from '../background/popup-protocol.js'

/**
 * The health summary panel.
 *
 * Split out of popup.ts, which had grown past 700 lines by holding the tab list, the
 * health panel, and the messaging client at once.
 */
const healthSummary = document.getElementById('healthSummary') as HTMLSpanElement
const healthNativeHost = document.getElementById('healthNativeHost') as HTMLDivElement
const healthWatcherReady = document.getElementById('healthWatcherReady') as HTMLDivElement
const healthWatcherId = document.getElementById('healthWatcherId') as HTMLDivElement
const healthAttachedCount = document.getElementById('healthAttachedCount') as HTMLDivElement
const healthSelectedTarget = document.getElementById('healthSelectedTarget') as HTMLDivElement
const healthLastMessage = document.getElementById('healthLastMessage') as HTMLDivElement
const healthPid = document.getElementById('healthPid') as HTMLDivElement

/** Repaint the health panel from the latest status. */
export const updateHealth = (
	status: PopupStatusPayload | undefined,
	watcher: PopupWatcherStatus | null,
	buttons: { copyAll: HTMLButtonElement; detachAll: HTMLButtonElement },
	hasWatchers: boolean,
): void => {
	const target = watcher?.currentTarget ?? null
	const tabCount = status?.attachedTabs.length ?? 0
	const nativeHostConnected = watcher?.bridgeConnected ?? status?.bridgeConnected ?? false
	const watcherReady = watcher?.watcherReady ?? false
	const targetState = watcher?.targetState ?? 'not-selected'

	healthSummary.textContent = buildHealthSummaryText({
		nativeHostConnected,
		watcherReady,
		targetState,
		watcherId: watcher?.watcherId ?? null,
		tabCount,
	})
	setHealthValueState(healthNativeHost, nativeHostConnected ? 'Connected' : 'Disconnected', nativeHostConnected ? 'connected' : 'disconnected')
	setHealthValueState(healthWatcherReady, watcherReady ? 'Ready' : 'Not ready', watcherReady ? 'connected' : 'disconnected')
	healthWatcherId.textContent = watcher?.watcherId ?? '-'
	healthAttachedCount.textContent = String(tabCount)
	setHealthValueState(healthSelectedTarget, formatTargetState(target, targetState), getTargetStateClass(targetState))
	healthLastMessage.textContent = formatRelativeTimestamp(watcher?.lastMessageAt ?? null)
	healthPid.textContent = watcher?.nativeHostPid ? String(watcher.nativeHostPid) : '-'
	buttons.copyAll.disabled = !hasWatchers
	buttons.detachAll.disabled = !hasWatchers
}

const buildHealthSummaryText = (input: {
	nativeHostConnected: boolean
	watcherReady: boolean
	targetState: PopupWatcherStatus['targetState']
	watcherId: string | null
	tabCount: number
}): string => {
	const parts: string[] = []
	if (input.watcherId) parts.push(input.watcherId)
	parts.push(input.nativeHostConnected ? 'Host connected' : 'Host disconnected')
	parts.push(input.watcherReady ? 'Watcher ready' : 'Watcher not ready')
	if (input.targetState === 'rebinding') parts.push('Target rebinding')
	if (input.tabCount > 0) parts.push(`${input.tabCount} tab${input.tabCount === 1 ? '' : 's'}`)
	return parts.join(' · ')
}

const setHealthValueState = (element: HTMLElement, text: string, stateClass: 'connected' | 'disconnected' | 'warning' | null): void => {
	element.textContent = text
	element.classList.toggle('connected', stateClass === 'connected')
	element.classList.toggle('disconnected', stateClass === 'disconnected')
	element.classList.toggle('warning', stateClass === 'warning')
}

const formatTargetState = (target: PopupCurrentTarget | null, state: PopupWatcherStatus['targetState']): string => {
	if (!target || state === 'not-selected') {
		return '-'
	}

	const label = target.type === 'page' ? 'Page' : 'Iframe'
	return state === 'ready' ? `${label} ready` : `${label} rebinding`
}

const getTargetStateClass = (state: PopupWatcherStatus['targetState']): 'connected' | 'disconnected' | 'warning' | null => {
	if (state === 'ready') {
		return 'connected'
	}
	if (state === 'rebinding') {
		return 'warning'
	}
	return null
}

function formatRelativeTimestamp(timestamp: number | null): string {
	if (!timestamp) {
		return '-'
	}

	const elapsedMs = Math.max(0, Date.now() - timestamp)
	if (elapsedMs < 1000) {
		return 'Just now'
	}

	const elapsedSeconds = Math.floor(elapsedMs / 1000)
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s ago`
	}

	const elapsedMinutes = Math.floor(elapsedSeconds / 60)
	if (elapsedMinutes < 60) {
		return `${elapsedMinutes}m ago`
	}

	const elapsedHours = Math.floor(elapsedMinutes / 60)
	return `${elapsedHours}h ago`
}
