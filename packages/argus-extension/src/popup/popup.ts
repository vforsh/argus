/**
 * Popup UI for the Argus CDP Bridge extension.
 * Displays tabs, target selection, and bridge/debugger health.
 */

import { escapeHtml } from './html.js'
import { renderTargetList } from './target-list.js'
import { runPopupMessage, sendPopupMessage } from './popup-client.js'
import { updateHealth } from './health-panel.js'
import { buildAllWatchersInfoText, buildWatcherInfoText, copyTextToClipboard, findWatcherByTabId } from './watcher-info.js'
import { clearTabFeedback, getTabFeedback, hasPendingTabFeedback, setTabFeedback, type TabButtonAction } from './tab-feedback.js'
import type { PopupStatusPayload, PopupTabAction, PopupTabWithTargets, PopupTargetAction, PopupWatcherStatus } from '../background/popup-protocol.js'

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
const copyAllButton = document.getElementById('copyAllButton') as HTMLButtonElement
const detachAllButton = document.getElementById('detachAllButton') as HTMLButtonElement

let prevStateHash = ''
let latestTabs: PopupTabWithTargets[] = []
let latestActiveTabId: number | undefined

/**
 * Repaint from the last loaded tabs without a round-trip.
 *
 * Button feedback lives in render state, so showing "Attaching…" is a re-render rather
 * than a mutation of the node the renderer is about to replace.
 */
async function renderFromLatestState(): Promise<void> {
	if (latestTabs.length > 0) {
		renderTabs(latestTabs, latestActiveTabId)
	}
}
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

// Prevent button clicks inside the health summary from toggling the <details> open/close.
document.querySelector('.health-summary-actions')?.addEventListener('click', (event) => {
	event.stopPropagation()
})

// Bound once, for the lifetime of the popup — never per render.
bindTabContainer(attachedContent)
bindTabContainer(availableContent)

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

function renderTabs(tabs: PopupTabWithTargets[], currentTabId?: number): void {
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

function renderTabItem(tab: PopupTabWithTargets, showTargets: boolean): string {
	const favicon = tab.faviconUrl
		? `<img class="tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="">`
		: `<div class="tab-favicon" style="background: #e0e0e0"></div>`
	const watcherSuffix = tab.attached && tab.watcher?.watcherId ? ` (${tab.watcher.watcherId})` : ''
	const actions = tab.attached ? renderAttachedTabActions(tab.tabId) : renderAttachButton(tab.tabId)
	const fullTitle = (tab.title || 'Untitled') + watcherSuffix

	return `
    <div class="tab-item ${tab.attached ? 'attached' : ''}" data-tab-id="${tab.tabId}">
      ${favicon}
      <div class="tab-info">
        <div class="tab-title" title="${escapeHtml(fullTitle)}">${escapeHtml(fullTitle)}</div>
        <div class="tab-url" title="${escapeHtml(tab.url)}">${escapeHtml(tab.url)}</div>
      </div>
      ${actions}
    </div>
    ${showTargets ? renderTargetList(tab) : ''}
  `
}

function renderTabGroup(section: HTMLDivElement, content: HTMLDivElement, tabs: PopupTabWithTargets[], showTargets: boolean): void {
	if (tabs.length === 0) {
		section.classList.add('hidden')
		content.innerHTML = ''
		return
	}

	section.classList.remove('hidden')
	content.innerHTML = `<div class="tab-list">${tabs.map((tab) => renderTabItem(tab, showTargets)).join('')}</div>`
}

/**
 * One delegated listener per tab container, bound once.
 *
 * Re-attaching handlers to every button on every render is what made the renderer and the
 * per-button mutation system fight over the same nodes; dispatching on `data-action`
 * survives any number of re-renders.
 */
function bindTabContainer(container: HTMLElement): void {
	container.addEventListener('click', (event) => {
		const actionButton = (event.target as HTMLElement).closest<HTMLButtonElement>('.tab-action, [data-action]')

		if (actionButton?.classList.contains('tab-action')) {
			void handleTabAction(actionButton)
			return
		}
		if (actionButton?.dataset.action === 'select-target') {
			void handleTargetSelection(actionButton)
			return
		}
		if (actionButton?.dataset.action === 'hide-target' || actionButton?.dataset.action === 'show-target') {
			event.stopPropagation()
			void handleTargetVisibility(actionButton)
			return
		}

		const tabItem = (event.target as HTMLElement).closest<HTMLElement>('.tab-item')
		if (tabItem) {
			void handleTabItemClick(tabItem)
		}
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
	const pending = getTabFeedback(tabId, 'attach')
	const disabled = pending ? ' disabled' : ''
	return `<button class="tab-action attach" data-tab-id="${tabId}" data-action="attach" type="button"${disabled}>${escapeHtml(pending?.label ?? 'Attach')}</button>`
}

function renderIconActionButton(tabId: number, action: Exclude<TabButtonAction, 'attach'>, variant: string, label: string, icon: string): string {
	const pending = getTabFeedback(tabId, action)
	return `
		<button
			class="tab-action icon-only ${variant}"
			data-tab-id="${tabId}"
			data-action="${action}"
			type="button"
			title="${escapeHtml(pending?.label ?? label)}"
			aria-label="${escapeHtml(pending?.label ?? label)}"
			${pending ? 'disabled' : ''}
		>
			<span class="tab-action-icon" aria-hidden="true">${pending?.icon ?? icon}</span>
		</button>
	`
}

async function handleTabItemClick(tabItem: HTMLElement): Promise<void> {
	const tabId = getTabId(tabItem)
	const action = getTabItemAction(tabItem)

	setTabFeedback(tabId, 'attach', action === 'attach' ? 'Attaching...' : 'Focusing...', Infinity)
	await renderFromLatestState()

	try {
		await runTabAction(action, tabId)
		clearTabFeedback(tabId, 'attach')
		if (action === 'attach') {
			await refreshTabs(true)
		} else {
			await renderFromLatestState()
		}
	} catch (error) {
		clearTabFeedback(tabId, 'attach')
		showError(error instanceof Error ? error.message : `${capitalize(action)} failed`)
		await renderFromLatestState()
	}
}

/**
 * Attached rows act like "jump to this Chrome tab"; unattached rows keep the existing one-click attach flow.
 */
function getTabItemAction(tabItem: HTMLElement): Extract<PopupTabAction, 'attach' | 'focusTab'> {
	return tabItem.classList.contains('attached') ? 'focusTab' : 'attach'
}

async function handleTabAction(button: HTMLButtonElement): Promise<void> {
	const tabId = getTabId(button)
	const action = button.dataset.action as TabButtonAction

	if (action === 'copy-info') {
		try {
			await copyWatcherInfo(tabId)
		} catch (error) {
			showError(error instanceof Error ? error.message : 'Copy failed')
		}
		return
	}

	setTabFeedback(tabId, action, action === 'attach' ? 'Attaching...' : 'Detaching...', Infinity)
	await renderFromLatestState()

	try {
		await runTabAction(action, tabId)
		clearTabFeedback(tabId, action)
		await refreshTabs(true)
	} catch (error) {
		clearTabFeedback(tabId, action)
		showError(error instanceof Error ? error.message : `${capitalize(action)} failed`)
		await renderFromLatestState()
	}
}

async function handleTargetSelection(button: HTMLButtonElement): Promise<void> {
	const tabId = getTabId(button)
	const frameId = button.dataset.frameId || null

	button.disabled = true

	try {
		await runTargetAction('selectTarget', tabId, frameId)
		await refreshTabs(true)
	} catch (error) {
		showError(error instanceof Error ? error.message : 'Target selection failed')
		button.disabled = false
	}
}

async function handleTargetVisibility(button: HTMLButtonElement): Promise<void> {
	const tabId = getTabId(button)
	const frameId = button.dataset.frameId || null
	const action = button.dataset.action === 'show-target' ? 'showTarget' : 'hideTarget'

	button.disabled = true

	try {
		await runTargetAction(action, tabId, frameId)
		await refreshTabs(true)
	} catch (error) {
		showError(error instanceof Error ? error.message : action === 'hideTarget' ? 'Target hide failed' : 'Target restore failed')
		button.disabled = false
	}
}

async function runTabAction(action: PopupTabAction, tabId: number): Promise<void> {
	await runPopupMessage({ action, tabId })
	showError(null)
}

async function runTargetAction(action: PopupTargetAction, tabId: number, frameId: string | null): Promise<void> {
	await runPopupMessage({ action, tabId, frameId })
	showError(null)
}

async function refreshTabs(forceRender = false): Promise<void> {
	try {
		const [statusResponse, tabsResponse, activeTab] = await Promise.all([
			sendPopupMessage({ action: 'getStatus' }),
			sendPopupMessage({ action: 'getTargets' }),
			getCurrentTab(),
		])

		if (!statusResponse.success) {
			throw new Error(statusResponse.error)
		}

		const status = statusResponse.status
		const tabs = tabsResponse.success ? tabsResponse.tabs : null
		const tabsError = tabsResponse.success ? null : tabsResponse.error

		latestWatchers = status.watchers
		latestCurrentWatcher = selectCurrentWatcher(status, tabs ?? [], activeTab?.id)

		const stateHash = JSON.stringify({
			status,
			tabs,
			currentTabId: activeTab?.id,
			error: currentError ?? tabsError,
		})

		// Live button feedback is render state too, so a pending one must not be skipped.
		if (!forceRender && stateHash === prevStateHash && !hasPendingTabFeedback()) {
			return
		}
		prevStateHash = stateHash

		updateStatus(status.bridgeConnected, status.attachedTabs.length)
		updateHealth(status, latestCurrentWatcher, { copyAll: copyAllButton, detachAll: detachAllButton }, latestWatchers.length > 0)

		if (tabs) {
			latestTabs = tabs
			latestActiveTabId = activeTab?.id
			renderTabs(tabs, activeTab?.id)
			showError(currentError)
			return
		}

		showError(tabsError ?? 'Failed to load tabs')
		setEmptyState('⚠️', tabsError ?? 'Failed to load tabs')
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to refresh popup'
		showError(message)
		updateStatus(false, 0)
		latestWatchers = []
		latestCurrentWatcher = null
		updateHealth(undefined, null, { copyAll: copyAllButton, detachAll: detachAllButton }, false)
		setEmptyState('⚠️', message)
	}
}

async function copyWatcherInfo(tabId: number): Promise<void> {
	const watcher = findWatcherByTabId(latestWatchers, tabId)
	const text = buildWatcherInfoText(watcher)
	if (!text) {
		return
	}

	await copyTextToClipboard(text)
	showError(null)
	setTabFeedback(tabId, 'copy-info', 'Copied!', 1500, CHECK_ICON)
	await renderFromLatestState()
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
			await runTabAction('detach', tabId)
		} catch {
			failures.push(tabId)
		}
	}

	return failures
}

function restoreButtonFeedback(button: HTMLButtonElement, label: string, timeoutMs = 1500, iconMarkup?: string): void {
	const restore = setButtonFeedback(button, label, iconMarkup)
	setTimeout(restore, timeoutMs)
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

function buildDetachAllError(failureCount: number): string {
	return failureCount === 1 ? 'Failed to detach 1 watcher' : `Failed to detach ${failureCount} watchers`
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1)
}

function selectCurrentWatcher(status: PopupStatusPayload | null, tabs: PopupTabWithTargets[], activeTabId?: number): PopupWatcherStatus | null {
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

async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
	return tabs[0]
}

void refreshTabs()
setInterval(() => {
	void refreshTabs()
}, 2000)
