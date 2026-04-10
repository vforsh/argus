/**
 * Popup UI for the Argus CDP Bridge extension.
 * Displays tabs, target selection, and bridge/debugger health.
 */

import { isLowInterestTarget } from './classify-target.js'

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

type PopupAction = 'attach' | 'detach' | 'focusTab' | 'selectTarget'
type TabButtonAction = 'attach' | 'detach' | 'copy-info'

const COPY_ICON = `
	<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
	</svg>
`

const CHECK_ICON = `
	<svg viewBox="0 0 16 16" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M3 8.5l3.1 3.1L13 4.75"></path>
	</svg>
`

const DETACH_ICON = `
	<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M5.4 1.75h5.2l3.65 3.65v5.2l-3.65 3.65H5.4l-3.65-3.65V5.4z"></path>
		<path d="M6 6l4 4"></path>
		<path d="M10 6l-4 4"></path>
	</svg>
`

// DOM elements
const statusIndicator = document.getElementById('statusIndicator') as HTMLDivElement
const statusText = document.getElementById('statusText') as HTMLSpanElement
const attachedSection = document.getElementById('attachedSection') as HTMLDivElement
const attachedContent = document.getElementById('attachedContent') as HTMLDivElement
const availableSection = document.getElementById('availableSection') as HTMLDivElement
const availableContent = document.getElementById('availableContent') as HTMLDivElement
const attachedCount = document.getElementById('attachedCount') as HTMLSpanElement
const errorBanner = document.getElementById('errorBanner') as HTMLDivElement
const healthBridge = document.getElementById('healthBridge') as HTMLDivElement
const healthWatcherId = document.getElementById('healthWatcherId') as HTMLDivElement
const healthAttachedCount = document.getElementById('healthAttachedCount') as HTMLDivElement
const healthSelectedTarget = document.getElementById('healthSelectedTarget') as HTMLDivElement
const healthLastMessage = document.getElementById('healthLastMessage') as HTMLDivElement
const healthPid = document.getElementById('healthPid') as HTMLDivElement
const copyAllButton = document.getElementById('copyAllButton') as HTMLButtonElement
const detachAllButton = document.getElementById('detachAllButton') as HTMLButtonElement

let prevStateHash = ''
let currentError: string | null = null
let latestCurrentWatcher: PopupWatcherStatus | null = null
// Copy actions run per attached row, so keep the latest watcher list alongside the focused watcher.
let latestWatchers: PopupWatcherStatus[] = []

copyAllButton.addEventListener('click', () => {
	void copyAllWatchersInfo().catch((error) => {
		showError(error instanceof Error ? error.message : 'Copy failed')
	})
})

detachAllButton.addEventListener('click', () => {
	void detachAllWatchers()
})

async function sendMessage<T>(message: { action: string; tabId?: number; frameId?: string | null }): Promise<T> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(message, resolve)
	})
}

function setEmptyState(icon: string, message: string): void {
	availableSection.classList.remove('hidden')
	attachedSection.classList.add('hidden')
	availableContent.innerHTML = `
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
	const hasWatchers = latestWatchers.length > 0
	copyAllButton.disabled = !hasWatchers
	detachAllButton.disabled = !hasWatchers
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

	renderTabGroup(attachedSection, attachedContent, attachedTabs, true)
	renderTabGroup(availableSection, availableContent, availableTabs, false)
}

function renderTabItem(tab: TabInfo, showTargets: boolean): string {
	const favicon = tab.faviconUrl
		? `<img class="tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="">`
		: `<div class="tab-favicon" style="background: #e0e0e0"></div>`
	const watcherSuffix = tab.attached && tab.watcher?.watcherId ? ` (${escapeHtml(tab.watcher.watcherId)})` : ''
	const actions = tab.attached ? renderAttachedTabActions(tab.tabId) : renderAttachButton(tab.tabId)

	return `
    <div class="tab-item ${tab.attached ? 'attached' : ''}" data-tab-id="${tab.tabId}">
      ${favicon}
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}${watcherSuffix}</div>
        <div class="tab-url">${escapeHtml(tab.url)}</div>
      </div>
      ${actions}
    </div>
    ${showTargets ? renderTargetList(tab) : ''}
  `
}

function renderTabGroup(section: HTMLDivElement, content: HTMLDivElement, tabs: TabInfo[], showTargets: boolean): void {
	if (tabs.length === 0) {
		section.classList.add('hidden')
		content.innerHTML = ''
		return
	}

	section.classList.remove('hidden')
	content.innerHTML = `<div class="tab-list">${tabs.map((tab) => renderTabItem(tab, showTargets)).join('')}</div>`
	bindTabInteractions(content)
}

function bindTabInteractions(root: ParentNode): void {
	root.querySelectorAll('.tab-action').forEach((button) => {
		button.addEventListener('click', handleTabAction)
	})
	root.querySelectorAll('[data-action="select-target"]').forEach((button) => {
		button.addEventListener('click', handleTargetSelection)
	})
	root.querySelectorAll('.tab-item').forEach((item) => {
		item.addEventListener('click', handleTabItemClick)
	})
}

function renderAttachedTabActions(tabId: number): string {
	return `
		<div class="tab-actions">
			${renderIconActionButton(tabId, 'copy-info', 'copy', 'Copy watcher info', COPY_ICON)}
			${renderIconActionButton(tabId, 'detach', 'detach', 'Detach', DETACH_ICON)}
		</div>
	`
}

function renderAttachButton(tabId: number): string {
	return `<button class="tab-action attach" data-tab-id="${tabId}" data-action="attach" type="button">Attach</button>`
}

function renderIconActionButton(tabId: number, action: Exclude<TabButtonAction, 'attach'>, variant: string, label: string, icon: string): string {
	return `
		<button
			class="tab-action icon-only ${variant}"
			data-tab-id="${tabId}"
			data-action="${action}"
			type="button"
			title="${label}"
			aria-label="${label}"
		>
			<span class="tab-action-icon" aria-hidden="true">${icon}</span>
		</button>
	`
}

function renderTargetList(tab: TabInfo): string {
	const targets = tab.targets ?? []
	if (targets.length <= 1) return ''

	const interesting: PopupTarget[] = []
	const lowInterest: PopupTarget[] = []
	for (const target of targets) {
		;(isLowInterestTarget(target) ? lowInterest : interesting).push(target)
	}

	const interestingHtml = interesting.map((t) => renderTargetItem(tab, t)).join('')

	if (lowInterest.length === 0) {
		return `<div class="target-list">${interestingHtml}</div>`
	}

	const hasSelectedLowInterest = lowInterest.some((t) => isTargetSelected(tab.selectedFrameId, t.frameId))
	const expanded = hasSelectedLowInterest ? 'open' : ''
	const lowInterestHtml = lowInterest.map((t) => renderTargetItem(tab, t)).join('')

	return `
    <div class="target-list">
      ${interestingHtml}
      <details class="target-collapsed" ${expanded}>
        <summary class="target-collapsed-toggle">
          ${lowInterest.length} other iframe${lowInterest.length === 1 ? '' : 's'}
        </summary>
        <div class="target-collapsed-list">
          ${lowInterestHtml}
        </div>
      </details>
    </div>
  `
}

function renderTargetItem(tab: TabInfo, target: PopupTarget): string {
	const isSelected = isTargetSelected(tab.selectedFrameId, target.frameId)
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
}

function isTargetSelected(selectedFrameId: string | null | undefined, targetFrameId: string | null): boolean {
	return selectedFrameId !== undefined && (selectedFrameId ?? null) === (targetFrameId ?? null)
}

async function handleTabItemClick(event: Event): Promise<void> {
	const target = event.target as HTMLElement
	if (target.closest('.tab-action')) {
		return
	}

	const tabItem = event.currentTarget as HTMLElement
	const tabId = getTabId(tabItem)
	const action = getTabItemAction(tabItem)

	tabItem.style.opacity = '0.6'
	tabItem.style.pointerEvents = 'none'

	try {
		await runPopupAction(action, { tabId })
		if (action === 'attach') {
			await refreshTabs(true)
		}
	} catch (error) {
		showError(error instanceof Error ? error.message : `${capitalize(action)} failed`)
		tabItem.style.opacity = '1'
		tabItem.style.pointerEvents = 'auto'
	}
}

/**
 * Attached rows act like "jump to this Chrome tab"; unattached rows keep the existing one-click attach flow.
 */
function getTabItemAction(tabItem: HTMLElement): Extract<PopupAction, 'attach' | 'focusTab'> {
	return tabItem.classList.contains('attached') ? 'focusTab' : 'attach'
}

async function handleTabAction(event: Event): Promise<void> {
	const button = (event.target as HTMLElement).closest('.tab-action') as HTMLButtonElement | null
	if (!button) {
		return
	}

	const tabId = getTabId(button)
	const action = button.dataset.action as TabButtonAction

	if (action === 'copy-info') {
		try {
			await copyWatcherInfo(tabId, button)
		} catch (error) {
			showError(error instanceof Error ? error.message : 'Copy failed')
		}
		return
	}

	const restoreButton = setBusyButtonState(button, action)

	try {
		await runPopupAction(action, { tabId })
		await refreshTabs(true)
	} catch (error) {
		showError(error instanceof Error ? error.message : `${capitalize(action)} failed`)
		restoreButton()
	}
}

async function handleTargetSelection(event: Event): Promise<void> {
	const button = event.currentTarget as HTMLButtonElement
	const tabId = getTabId(button)
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
		latestWatchers = status?.watchers ?? []
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
		updateHealth(status, latestCurrentWatcher)

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
		latestWatchers = []
		latestCurrentWatcher = null
		updateHealth(undefined, null)
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

async function copyWatcherInfo(tabId: number, button: HTMLButtonElement): Promise<void> {
	const watcher = findWatcherByTabId(latestWatchers, tabId)
	const text = buildWatcherInfoText(watcher)
	if (!text) {
		return
	}

	await copyTextToClipboard(text)
	showError(null)
	restoreButtonFeedback(button, 'Copied!', 1500, CHECK_ICON)
}

async function copyAllWatchersInfo(): Promise<void> {
	const text = buildAllWatchersInfoText(latestWatchers)
	if (!text) {
		return
	}

	await copyTextToClipboard(text)
	showError(null)
	restoreButtonFeedback(copyAllButton, 'Copied!')
}

async function copyTextToClipboard(text: string): Promise<void> {
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

async function detachAllWatchers(): Promise<void> {
	if (latestWatchers.length === 0) {
		return
	}

	const restoreBusyState = setButtonFeedback(detachAllButton, 'Detaching...')
	const failures = await detachWatchers(latestWatchers.map((watcher) => watcher.tabId))
	restoreBusyState()
	await refreshTabs(true)

	if (failures.length > 0) {
		showError(buildDetachAllError(failures.length))
		return
	}

	showError(null)
	restoreButtonFeedback(detachAllButton, 'Detached!')
}

/**
 * Detach watchers one by one so a single failure does not block the rest of the cleanup.
 */
async function detachWatchers(tabIds: number[]): Promise<number[]> {
	const failures: number[] = []

	for (const tabId of tabIds) {
		try {
			await runPopupAction('detach', { tabId })
		} catch {
			failures.push(tabId)
		}
	}

	return failures
}

function setBusyButtonState(button: HTMLButtonElement, action: Extract<TabButtonAction, 'attach' | 'detach'>): () => void {
	const previousMarkup = button.innerHTML
	const restoreFeedback = setButtonFeedback(button, action === 'attach' ? 'Attaching...' : 'Detaching...')
	if (action === 'attach') {
		button.textContent = 'Attaching...'
	}

	return () => {
		button.innerHTML = previousMarkup
		restoreFeedback()
	}
}

function restoreButtonFeedback(button: HTMLButtonElement, label: string, timeoutMs = 1500, iconMarkup?: string): void {
	const restore = setButtonFeedback(button, label, iconMarkup)
	setTimeout(() => {
		restore()
	}, timeoutMs)
}

function setButtonFeedback(button: HTMLButtonElement, label: string, iconMarkup?: string): () => void {
	const previousTitle = button.title
	const previousLabel = button.getAttribute('aria-label')
	const previousText = getButtonLabel(button)
	const previousIcon = getButtonIconMarkup(button)
	const previousDisabled = button.disabled

	button.disabled = true
	button.title = label
	button.setAttribute('aria-label', label)
	setButtonLabel(button, label)
	if (iconMarkup) {
		setButtonIconMarkup(button, iconMarkup)
	}

	return () => {
		button.disabled = previousDisabled
		button.title = previousTitle
		button.setAttribute('aria-label', previousLabel ?? previousTitle)
		setButtonLabel(button, previousText)
		setButtonIconMarkup(button, previousIcon)
	}
}

function buildWatcherInfoText(watcher: PopupWatcherStatus | null): string | null {
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

function buildAllWatchersInfoText(watchers: PopupWatcherStatus[]): string | null {
	const watcherInfo = watchers.map((watcher) => buildWatcherInfoText(watcher)).filter((text): text is string => Boolean(text))
	if (watcherInfo.length === 0) {
		return null
	}

	return watcherInfo.join('\n\n')
}

function buildDetachAllError(failureCount: number): string {
	return failureCount === 1 ? 'Failed to detach 1 watcher' : `Failed to detach ${failureCount} watchers`
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

function getTabId(element: HTMLElement): number {
	return parseInt(element.dataset.tabId ?? '0', 10)
}

function getButtonLabel(button: HTMLButtonElement): string {
	return button.querySelector<HTMLElement>('[data-button-label]')?.textContent ?? ''
}

function setButtonLabel(button: HTMLButtonElement, label: string): void {
	const labelNode = button.querySelector<HTMLElement>('[data-button-label]')
	if (labelNode) {
		labelNode.textContent = label
	}
}

function getButtonIconMarkup(button: HTMLButtonElement): string {
	return button.querySelector<HTMLElement>('.tab-action-icon')?.innerHTML ?? ''
}

function setButtonIconMarkup(button: HTMLButtonElement, iconMarkup: string): void {
	const iconNode = button.querySelector<HTMLElement>('.tab-action-icon')
	if (iconNode) {
		iconNode.innerHTML = iconMarkup
	}
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
