/**
 * Popup UI for the Argus CDP Bridge extension.
 * Displays available tabs and allows attaching/detaching.
 */

type TabInfo = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
	selectedFrameId?: string | null
	targets?: PopupTarget[]
}

type PopupTarget = {
	type: 'page' | 'iframe'
	frameId: string | null
	parentFrameId: string | null
	title: string
	url: string
}

type StatusResponse = {
	success: boolean
	status?: {
		bridgeConnected: boolean
		attachedTabs: Array<{ tabId: number; url: string; title: string }>
	}
	error?: string
}

type TabsResponse = {
	success: boolean
	tabs?: TabInfo[]
	error?: string
}

// DOM elements
const statusIndicator = document.getElementById('statusIndicator') as HTMLDivElement
const statusText = document.getElementById('statusText') as HTMLSpanElement
const content = document.getElementById('content') as HTMLDivElement
const attachedCount = document.getElementById('attachedCount') as HTMLSpanElement

// Previous state for diffing (avoid unnecessary re-renders)
let prevStateHash = ''

/**
 * Send a message to the service worker.
 */
async function sendMessage<T>(message: { action: string; tabId?: number; frameId?: string | null }): Promise<T> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(message, resolve)
	})
}

/**
 * Update the connection status display.
 */
function updateStatus(connected: boolean, tabCount: number): void {
	if (connected) {
		statusIndicator.classList.add('connected')
		statusText.textContent = 'Bridge connected'
	} else {
		statusIndicator.classList.remove('connected')
		statusText.textContent = 'Bridge disconnected'
	}

	attachedCount.textContent = `${tabCount} attached`
}

/**
 * Render the tab list.
 */
function renderTabs(tabs: TabInfo[], currentTabId?: number): void {
	if (tabs.length === 0) {
		content.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <div>No tabs available</div>
      </div>
    `
		return
	}

	const attachedTabs = tabs.filter((t) => t.attached)
	let availableTabs = tabs.filter((t) => !t.attached)

	// Move current tab to the beginning of Available Tabs list
	if (currentTabId !== undefined) {
		const currentTabIndex = availableTabs.findIndex((t) => t.tabId === currentTabId)
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

	// Add event listeners
	content.querySelectorAll('.tab-action').forEach((btn) => {
		btn.addEventListener('click', handleTabAction)
	})
	content.querySelectorAll('[data-action="select-target"]').forEach((btn) => {
		btn.addEventListener('click', handleTargetSelection)
	})
	content.querySelectorAll('.tab-item').forEach((item) => {
		item.addEventListener('click', handleTabItemClick)
	})
}

/**
 * Render a single tab item.
 */
function renderTabItem(tab: TabInfo, showTargets: boolean): string {
	const favicon = tab.faviconUrl
		? `<img class="tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="">`
		: `<div class="tab-favicon" style="background: #e0e0e0"></div>`

	const actionButton = tab.attached
		? `<button class="tab-action detach" data-tab-id="${tab.tabId}" data-action="detach">Detach</button>`
		: `<button class="tab-action attach" data-tab-id="${tab.tabId}" data-action="attach">Attach</button>`

	const targetsHtml = showTargets ? renderTargetList(tab) : ''

	return `
    <div class="tab-item ${tab.attached ? 'attached' : ''}" data-tab-id="${tab.tabId}">
      ${favicon}
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}</div>
        <div class="tab-url">${escapeHtml(tab.url)}</div>
      </div>
      ${actionButton}
    </div>
    ${targetsHtml}
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
				const isSelected = (tab.selectedFrameId ?? null) === (target.frameId ?? null)
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

/**
 * Handle click on tab item (attach/detach based on current state).
 */
async function handleTabItemClick(event: Event): Promise<void> {
	const target = event.target as HTMLElement
	// Ignore clicks on the button (it's handled separately)
	if (target.closest('.tab-action')) {
		return
	}

	const tabItem = event.currentTarget as HTMLElement
	const tabId = parseInt(tabItem.dataset.tabId ?? '0', 10)
	const isAttached = tabItem.classList.contains('attached')
	const action = isAttached ? 'detach' : 'attach'

	// Show loading state
	tabItem.style.opacity = '0.6'
	tabItem.style.pointerEvents = 'none'

	try {
		await sendMessage({ action, tabId })
		await refreshTabs(true)
	} catch (err) {
		console.error('Action failed:', err)
		tabItem.style.opacity = '1'
		tabItem.style.pointerEvents = 'auto'
	}
}

function renderTabSection(title: string, tabs: TabInfo[], showTargets: boolean): string {
	return `
    <div class="section-title">${title}</div>
    <div class="tab-list">
      ${tabs.map((tab) => renderTabItem(tab, showTargets)).join('')}
    </div>
  `
}

/**
 * Handle attach/detach button click.
 */
async function handleTabAction(event: Event): Promise<void> {
	const button = event.target as HTMLButtonElement
	const tabId = parseInt(button.dataset.tabId ?? '0', 10)
	const action = button.dataset.action as 'attach' | 'detach'

	button.disabled = true
	button.textContent = action === 'attach' ? 'Attaching...' : 'Detaching...'

	try {
		await sendMessage({ action, tabId })
		// Refresh the tab list
		await refreshTabs(true)
	} catch (err) {
		console.error('Action failed:', err)
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
		await sendMessage({ action: 'selectTarget', tabId, frameId })
		await refreshTabs(true)
	} catch (err) {
		console.error('Target selection failed:', err)
		button.disabled = false
	}
}

/**
 * Refresh the tab list and status.
 */
async function refreshTabs(forceRender = false): Promise<void> {
	const [statusResponse, tabsResponse, activeTab] = await Promise.all([
		sendMessage<StatusResponse>({ action: 'getStatus' }),
		sendMessage<TabsResponse>({ action: 'getTargets' }),
		getCurrentTab(),
	])

	const connected = statusResponse.status?.bridgeConnected ?? false
	const attachedTabCount = statusResponse.status?.attachedTabs.length ?? 0

	// Compute state hash to avoid unnecessary re-renders
	const stateHash = JSON.stringify({
		connected,
		attachedTabCount,
		tabs: tabsResponse.tabs,
		currentTabId: activeTab?.id,
		error: tabsResponse.error,
	})

	if (!forceRender && stateHash === prevStateHash) {
		return
	}
	prevStateHash = stateHash

	updateStatus(connected, attachedTabCount)

	if (tabsResponse.success && tabsResponse.tabs) {
		renderTabs(tabsResponse.tabs, activeTab?.id)
	} else {
		content.innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <div>${tabsResponse.error ?? 'Failed to load tabs'}</div>
      </div>
    `
	}
}

/**
 * Escape HTML entities.
 */
function escapeHtml(text: string): string {
	const div = document.createElement('div')
	div.textContent = text
	return div.innerHTML
}

async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
	return tabs[0]
}

// Initial load
refreshTabs()

// Refresh periodically while popup is open
setInterval(refreshTabs, 2000)
