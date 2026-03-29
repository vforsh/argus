/**
 * Popup UI for the Argus CDP Bridge extension.
 * Displays tabs, target selection, and bridge/debugger health.
 */

type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
}

type TabInfo = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
	selectedFrameId?: string | null
	targets?: PopupTarget[]
	watcher: PopupWatcherStatus | null
}

type PopupEvent = {
	ts: number
	level: 'info' | 'error'
	source: 'bridge' | 'debugger' | 'popup'
	message: string
}

type CurrentTargetSummary = {
	tabId: number
	type: 'page' | 'iframe'
	title: string | null
	url: string | null
	targetId: string
	frameId: string | null
	attachedAt: number
}

type StatusPayload = {
	bridgeConnected: boolean
	attachedTabs: Array<{ tabId: number; url: string; title: string }>
	watchers: PopupWatcherStatus[]
	recentEvents: PopupEvent[]
}

type PopupWatcherStatus = {
	tabId: number
	bridgeConnected: boolean
	watcherId: string | null
	watcherHost: string | null
	watcherPort: number | null
	nativeHostPid: number | null
	lastMessageAt: number | null
	currentTarget: CurrentTargetSummary | null
}

type StatusResponse = {
	success: boolean
	status?: StatusPayload
	error?: string
}

type TabsResponse = {
	success: boolean
	tabs?: TabInfo[]
	error?: string
}

type ActionResponse = {
	success: boolean
	error?: string
}

type PopupAction = 'attach' | 'detach' | 'selectTarget'

// DOM elements
const statusIndicator = document.getElementById('statusIndicator') as HTMLDivElement
const statusText = document.getElementById('statusText') as HTMLSpanElement
const content = document.getElementById('content') as HTMLDivElement
const attachedCount = document.getElementById('attachedCount') as HTMLSpanElement
const errorBanner = document.getElementById('errorBanner') as HTMLDivElement
const currentTargetPill = document.getElementById('currentTargetPill') as HTMLDivElement
const currentTargetKind = document.getElementById('currentTargetKind') as HTMLSpanElement
const currentTargetTitle = document.getElementById('currentTargetTitle') as HTMLDivElement
const currentTargetUrl = document.getElementById('currentTargetUrl') as HTMLDivElement
const copyInfoButton = document.getElementById('copyInfoButton') as HTMLButtonElement
const healthBridge = document.getElementById('healthBridge') as HTMLDivElement
const healthWatcherId = document.getElementById('healthWatcherId') as HTMLDivElement
const healthAttachedCount = document.getElementById('healthAttachedCount') as HTMLDivElement
const healthSelectedTarget = document.getElementById('healthSelectedTarget') as HTMLDivElement
const healthLastMessage = document.getElementById('healthLastMessage') as HTMLDivElement
const healthPid = document.getElementById('healthPid') as HTMLDivElement
const eventList = document.getElementById('eventList') as HTMLDivElement

let prevStateHash = ''
let currentError: string | null = null
let latestCurrentWatcher: PopupWatcherStatus | null = null

copyInfoButton.addEventListener('click', () => {
	void copyWatcherInfo()
})

async function sendMessage<T>(message: { action: string; tabId?: number; frameId?: string | null }): Promise<T> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(message, resolve)
	})
}

function setEmptyState(icon: string, message: string): void {
	content.innerHTML = `
      <div class="empty-state">
        <div class="icon">${escapeHtml(icon)}</div>
        <div>${escapeHtml(message)}</div>
      </div>
    `
}

function updateStatus(connected: boolean, tabCount: number): void {
	statusIndicator.classList.toggle('connected', connected)
	statusText.textContent = connected ? 'Bridge connected' : 'Bridge disconnected'
	attachedCount.textContent = `${tabCount} attached`
}

function showError(message: string | null): void {
	currentError = message
	errorBanner.textContent = message ?? ''
	errorBanner.classList.toggle('hidden', !message)
}

function updateCurrentTarget(watcher: PopupWatcherStatus | null): void {
	const target = watcher?.currentTarget ?? null
	const hasTarget = Boolean(target)

	currentTargetPill.classList.toggle('empty', !hasTarget)
	currentTargetKind.textContent = target ? (target.type === 'page' ? 'Page' : 'Iframe') : 'Target'
	currentTargetTitle.textContent = target ? target.title || shortenUrl(target.url ?? '') : 'No target selected'
	currentTargetUrl.textContent = target?.url ? shortenUrl(target.url) : 'Attach a tab to get started'
	copyInfoButton.disabled = !canCopyWatcherInfo(watcher)
}

function updateHealth(status: StatusPayload | undefined, watcher: PopupWatcherStatus | null): void {
	const connected = watcher?.bridgeConnected ?? status?.bridgeConnected ?? false
	const target = watcher?.currentTarget ?? null

	healthBridge.textContent = connected ? 'Connected' : 'Disconnected'
	healthBridge.classList.toggle('connected', connected)
	healthBridge.classList.toggle('disconnected', !connected)
	healthWatcherId.textContent = watcher?.watcherId ?? '-'
	healthAttachedCount.textContent = String(status?.attachedTabs.length ?? 0)
	healthSelectedTarget.textContent = target ? `${target.type === 'page' ? 'Page' : 'Iframe'} ${target.targetId}` : '-'
	healthLastMessage.textContent = formatTimestamp(watcher?.lastMessageAt ?? null)
	healthPid.textContent = watcher?.nativeHostPid ? String(watcher.nativeHostPid) : '-'
}

function renderEvents(events: PopupEvent[]): void {
	if (events.length === 0) {
		eventList.innerHTML = '<div class="loading">No events yet</div>'
		return
	}

	eventList.innerHTML = events
		.map(
			(event) => `
      <div class="event-item ${event.level}">
        <div class="event-meta">
          <span class="event-level">${escapeHtml(event.level)}</span>
          <span>${escapeHtml(event.source)}</span>
          <span>${escapeHtml(formatTimestamp(event.ts))}</span>
        </div>
        <div class="event-message">${escapeHtml(event.message)}</div>
      </div>
    `,
		)
		.join('')
}

function renderTabs(tabs: TabInfo[], currentTabId?: number): void {
	if (tabs.length === 0) {
		setEmptyState('🔍', 'No tabs available')
		return
	}

	const attachedTabs = tabs.filter((tab) => tab.attached)
	let availableTabs = tabs.filter((tab) => !tab.attached)

	if (currentTabId !== undefined) {
		const currentTabIndex = availableTabs.findIndex((tab) => tab.tabId === currentTabId)
		if (currentTabIndex > 0) {
			const [currentTab] = availableTabs.splice(currentTabIndex, 1)
			availableTabs.unshift(currentTab)
		}
	}

	let html = ''
	if (attachedTabs.length > 0) {
		html += renderTabSection('Attached Tabs', attachedTabs, true)
	}

	if (availableTabs.length > 0) {
		if (attachedTabs.length > 0) {
			html += '<div style="height: 16px"></div>'
		}
		html += renderTabSection('Available Tabs', availableTabs, false)
	}

	content.innerHTML = html
	content.querySelectorAll('.tab-action').forEach((button) => {
		button.addEventListener('click', handleTabAction)
	})
	content.querySelectorAll('[data-action="select-target"]').forEach((button) => {
		button.addEventListener('click', handleTargetSelection)
	})
	content.querySelectorAll('.tab-item').forEach((item) => {
		item.addEventListener('click', handleTabItemClick)
	})
}

function renderTabSection(title: string, tabs: TabInfo[], showTargets: boolean): string {
	return `
    <div class="section-title">${title}</div>
    <div class="tab-list">
      ${tabs.map((tab) => renderTabItem(tab, showTargets)).join('')}
    </div>
  `
}

function renderTabItem(tab: TabInfo, showTargets: boolean): string {
	const favicon = tab.faviconUrl
		? `<img class="tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="">`
		: `<div class="tab-favicon" style="background: #e0e0e0"></div>`
	const actionButton = tab.attached
		? `<button class="tab-action detach" data-tab-id="${tab.tabId}" data-action="detach">Detach</button>`
		: `<button class="tab-action attach" data-tab-id="${tab.tabId}" data-action="attach">Attach</button>`
	const watcherSuffix = tab.attached && tab.watcher?.watcherId ? ` (${escapeHtml(tab.watcher.watcherId)})` : ''

	return `
    <div class="tab-item ${tab.attached ? 'attached' : ''}" data-tab-id="${tab.tabId}">
      ${favicon}
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}${watcherSuffix}</div>
        <div class="tab-url">${escapeHtml(tab.url)}</div>
      </div>
      ${actionButton}
    </div>
    ${showTargets ? renderTargetList(tab) : ''}
  `
}

function renderTargetList(tab: TabInfo): string {
	const targets = tab.targets ?? []
	if (targets.length <= 1) {
		return ''
	}

	return `
    <div class="target-list">
      ${targets
			.map((target) => {
				const isSelected = tab.selectedFrameId !== undefined && (tab.selectedFrameId ?? null) === (target.frameId ?? null)
				const kindLabel = target.type === 'page' ? 'Page' : 'Iframe'
				return `
            <button
              class="target-item ${isSelected ? 'selected' : ''}"
              data-action="select-target"
              data-tab-id="${tab.tabId}"
              data-frame-id="${escapeHtml(target.frameId ?? '')}"
              type="button"
            >
              <span class="target-kind">${kindLabel}</span>
              <span class="target-meta">
                <span class="target-title">${escapeHtml(target.title || kindLabel)}</span>
                <span class="target-url">${escapeHtml(target.url || '(no url)')}</span>
              </span>
            </button>
          `
			})
			.join('')}
    </div>
  `
}

async function handleTabItemClick(event: Event): Promise<void> {
	const target = event.target as HTMLElement
	if (target.closest('.tab-action')) {
		return
	}

	const tabItem = event.currentTarget as HTMLElement
	if (tabItem.classList.contains('attached')) {
		return
	}

	const tabId = parseInt(tabItem.dataset.tabId ?? '0', 10)
	const action: PopupAction = 'attach'

	tabItem.style.opacity = '0.6'
	tabItem.style.pointerEvents = 'none'

	try {
		await runPopupAction(action, { tabId })
		await refreshTabs(true)
	} catch (error) {
		showError(error instanceof Error ? error.message : `${capitalize(action)} failed`)
		tabItem.style.opacity = '1'
		tabItem.style.pointerEvents = 'auto'
	}
}

async function handleTabAction(event: Event): Promise<void> {
	const button = event.target as HTMLButtonElement
	const tabId = parseInt(button.dataset.tabId ?? '0', 10)
	const action = button.dataset.action as 'attach' | 'detach'

	button.disabled = true
	button.textContent = action === 'attach' ? 'Attaching...' : 'Detaching...'

	try {
		await runPopupAction(action, { tabId })
		await refreshTabs(true)
	} catch (error) {
		showError(error instanceof Error ? error.message : `${capitalize(action)} failed`)
		button.disabled = false
		button.textContent = action === 'attach' ? 'Attach' : 'Detach'
	}
}

async function handleTargetSelection(event: Event): Promise<void> {
	const button = event.currentTarget as HTMLButtonElement
	const tabId = parseInt(button.dataset.tabId ?? '0', 10)
	const frameId = button.dataset.frameId || null

	button.disabled = true

	try {
		await runPopupAction('selectTarget', { tabId, frameId })
		await refreshTabs(true)
	} catch (error) {
		showError(error instanceof Error ? error.message : 'Target selection failed')
		button.disabled = false
	}
}

async function runPopupAction(action: PopupAction, args: { tabId: number; frameId?: string | null }): Promise<void> {
	const response = await sendMessage<ActionResponse>({ action, ...args })
	if (!response.success) {
		throw new Error(response.error ?? `${capitalize(action)} failed`)
	}

	showError(null)
}

async function refreshTabs(forceRender = false): Promise<void> {
	try {
		const [statusResponse, tabsResponse, activeTab] = await Promise.all([
			sendMessage<StatusResponse>({ action: 'getStatus' }),
			sendMessage<TabsResponse>({ action: 'getTargets' }),
			getCurrentTab(),
		])

		if (!statusResponse.success) {
			throw new Error(statusResponse.error ?? 'Failed to load bridge status')
		}

		const status = statusResponse.status
		latestCurrentWatcher = selectCurrentWatcher(status ?? null, tabsResponse.tabs ?? [], activeTab?.id)

		const stateHash = JSON.stringify({
			status,
			tabs: tabsResponse.tabs,
			currentTabId: activeTab?.id,
			error: currentError ?? tabsResponse.error ?? null,
		})

		if (!forceRender && stateHash === prevStateHash) {
			return
		}
		prevStateHash = stateHash

		updateStatus(status?.bridgeConnected ?? false, status?.attachedTabs.length ?? 0)
		updateCurrentTarget(latestCurrentWatcher)
		updateHealth(status, latestCurrentWatcher)
		renderEvents(status?.recentEvents ?? [])

		if (tabsResponse.success && tabsResponse.tabs) {
			renderTabs(tabsResponse.tabs, activeTab?.id)
			showError(currentError)
			return
		}

		showError(tabsResponse.error ?? 'Failed to load tabs')
		setEmptyState('⚠️', tabsResponse.error ?? 'Failed to load tabs')
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to refresh popup'
		showError(message)
		updateStatus(false, 0)
		latestCurrentWatcher = null
		updateCurrentTarget(null)
		updateHealth(undefined, null)
		renderEvents([])
		setEmptyState('⚠️', message)
	}
}

function formatTimestamp(timestamp: number | null): string {
	if (!timestamp) {
		return '-'
	}

	return new Date(timestamp).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	})
}

function shortenUrl(input: string): string {
	try {
		const url = new URL(input)
		const path = `${url.pathname}${url.hash}` || '/'
		return `${url.host}${path.length > 28 ? `${path.slice(0, 27)}…` : path}`
	} catch {
		return input.length > 44 ? `${input.slice(0, 43)}…` : input
	}
}

async function copyWatcherInfo(): Promise<void> {
	const text = buildWatcherInfoText()
	if (!text) {
		return
	}

	await navigator.clipboard.writeText(text)
	const previousText = copyInfoButton.textContent
	copyInfoButton.textContent = 'Copied!'
	setTimeout(() => {
		copyInfoButton.textContent = previousText
	}, 1500)
}

function buildWatcherInfoText(): string | null {
	if (!canCopyWatcherInfo(latestCurrentWatcher)) {
		return null
	}

	const watcher = latestCurrentWatcher!
	const target = watcher.currentTarget!
	const attached = target.attachedAt ? new Date(target.attachedAt).toISOString() : new Date().toISOString()
	const fields = [
		['ID', watcher.watcherId!],
		['Host', `${watcher.watcherHost!}:${watcher.watcherPort!}`],
		['PID', String(watcher.nativeHostPid!)],
		['Target', target.title || '(no title)'],
		['URL', target.url || '(no url)'],
		['Attached', attached],
	]

	return `Argus Watcher Info\n${fields.map(([label, value]) => `${label}: ${value}`).join('\n')}`
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1)
}

function selectCurrentWatcher(status: StatusPayload | null, tabs: TabInfo[], activeTabId?: number): PopupWatcherStatus | null {
	if (!status) {
		return null
	}

	if (activeTabId !== undefined) {
		const activeWatcher = findWatcherByTabId(status.watchers, activeTabId)
		if (activeWatcher) {
			return activeWatcher
		}
	}

	for (const tab of tabs) {
		if (!tab.attached) {
			continue
		}

		const watcher = findWatcherByTabId(status.watchers, tab.tabId)
		if (watcher) {
			return watcher
		}
	}

	return status.watchers[0] ?? null
}

function canCopyWatcherInfo(watcher: PopupWatcherStatus | null | undefined): boolean {
	return Boolean(watcher?.watcherId && watcher?.watcherHost && watcher?.watcherPort != null && watcher?.nativeHostPid && watcher?.currentTarget)
}

function findWatcherByTabId(watchers: PopupWatcherStatus[], tabId: number): PopupWatcherStatus | null {
	return watchers.find((watcher) => watcher.tabId === tabId) ?? null
}

function escapeHtml(text: string): string {
	const div = document.createElement('div')
	div.textContent = text
	return div.innerHTML
}

async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
	return tabs[0]
}

void refreshTabs()
setInterval(() => {
	void refreshTabs()
}, 2000)
