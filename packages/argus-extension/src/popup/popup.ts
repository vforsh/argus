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

/**
 * Send a message to the service worker.
 */
async function sendMessage<T>(message: { action: string; tabId?: number }): Promise<T> {
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
function renderTabs(tabs: TabInfo[]): void {
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
	const availableTabs = tabs.filter((t) => !t.attached)

	let html = ''

	if (attachedTabs.length > 0) {
		html += `
      <div class="section-title">Attached Tabs</div>
      <div class="tab-list">
        ${attachedTabs.map((tab) => renderTabItem(tab)).join('')}
      </div>
    `
	}

	if (availableTabs.length > 0) {
		if (attachedTabs.length > 0) {
			html += '<div style="height: 16px"></div>'
		}
		html += `
      <div class="section-title">Available Tabs</div>
      <div class="tab-list">
        ${availableTabs.map((tab) => renderTabItem(tab)).join('')}
      </div>
    `
	}

	content.innerHTML = html

	// Add event listeners
	content.querySelectorAll('.tab-action').forEach((btn) => {
		btn.addEventListener('click', handleTabAction)
	})
}

/**
 * Render a single tab item.
 */
function renderTabItem(tab: TabInfo): string {
	const favicon = tab.faviconUrl
		? `<img class="tab-favicon" src="${escapeHtml(tab.faviconUrl)}" alt="">`
		: `<div class="tab-favicon" style="background: #333"></div>`

	const actionButton = tab.attached
		? `<button class="tab-action detach" data-tab-id="${tab.tabId}" data-action="detach">Detach</button>`
		: `<button class="tab-action attach" data-tab-id="${tab.tabId}" data-action="attach">Attach</button>`

	return `
    <div class="tab-item ${tab.attached ? 'attached' : ''}" data-tab-id="${tab.tabId}">
      ${favicon}
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}</div>
        <div class="tab-url">${escapeHtml(tab.url)}</div>
      </div>
      ${actionButton}
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
		await refreshTabs()
	} catch (err) {
		console.error('Action failed:', err)
		button.disabled = false
		button.textContent = action === 'attach' ? 'Attach' : 'Detach'
	}
}

/**
 * Refresh the tab list and status.
 */
async function refreshTabs(): Promise<void> {
	const [statusResponse, tabsResponse] = await Promise.all([
		sendMessage<StatusResponse>({ action: 'getStatus' }),
		sendMessage<TabsResponse>({ action: 'getTabs' }),
	])

	const connected = statusResponse.status?.bridgeConnected ?? false
	const attachedTabCount = statusResponse.status?.attachedTabs.length ?? 0

	updateStatus(connected, attachedTabCount)

	if (tabsResponse.success && tabsResponse.tabs) {
		renderTabs(tabsResponse.tabs)
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

// Initial load
refreshTabs()

// Refresh periodically while popup is open
setInterval(refreshTabs, 2000)
