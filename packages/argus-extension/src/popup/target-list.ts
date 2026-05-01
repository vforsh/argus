import { isLowInterestTarget } from './classify-target.js'
import type { PopupTarget, TabInfo } from './types.js'

const HIDE_TARGET_ICON = `
	<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M10.7 5.1A10.7 10.7 0 0 1 12 5c5 0 8.5 4.5 9.5 6a13.4 13.4 0 0 1-2.7 3.2"></path>
		<path d="M6.6 6.7A13.4 13.4 0 0 0 2.5 11c1 1.5 4.5 6 9.5 6a8.7 8.7 0 0 0 4.2-1.1"></path>
		<path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"></path>
		<path d="M3 3l18 18"></path>
	</svg>
`

const SHOW_TARGET_ICON = `
	<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path>
		<circle cx="12" cy="12" r="3"></circle>
	</svg>
`

export function renderTargetList(tab: TabInfo): string {
	const targets = tab.targets ?? []
	const hiddenTargets = tab.hiddenTargets ?? []
	if (targets.length <= 1 && hiddenTargets.length === 0) return ''

	const primaryTargets: PopupTarget[] = []
	const autoHiddenTargets: PopupTarget[] = []
	for (const target of targets) {
		if (isLowInterestTarget(target)) {
			autoHiddenTargets.push(target)
		} else {
			primaryTargets.push(target)
		}
	}

	const primaryHtml = renderTargetItems(tab, primaryTargets, 'visible')
	const hiddenFramesHtml = renderHiddenFramesSection(tab, autoHiddenTargets, hiddenTargets)

	return `
		<div class="target-list">
			${primaryHtml}
			${hiddenFramesHtml}
		</div>
	`
}

function renderHiddenFramesSection(tab: TabInfo, autoHiddenTargets: PopupTarget[], manuallyHiddenTargets: PopupTarget[]): string {
	const count = autoHiddenTargets.length + manuallyHiddenTargets.length
	if (count === 0) {
		return ''
	}

	const hasSelectedAutoHiddenTarget = autoHiddenTargets.some((target) => isTargetSelected(tab.selectedFrameId, target.frameId))
	const autoHiddenHtml = renderTargetItems(tab, autoHiddenTargets, 'visible')
	const manuallyHiddenHtml = renderTargetItems(tab, manuallyHiddenTargets, 'hidden')
	const expanded = hasSelectedAutoHiddenTarget ? 'open' : ''

	return `
      <details class="target-collapsed target-hidden-list" ${expanded}>
        <summary class="target-collapsed-toggle">
          ${count} hidden frame${count === 1 ? '' : 's'}
        </summary>
        <div class="target-collapsed-list">
          ${autoHiddenHtml}
          ${manuallyHiddenHtml}
        </div>
      </details>
  `
}

function renderTargetItems(tab: TabInfo, targets: PopupTarget[], visibility: 'visible' | 'hidden'): string {
	return targets.map((target) => renderTargetItem(tab, target, visibility)).join('')
}

function renderTargetItem(tab: TabInfo, target: PopupTarget, visibility: 'visible' | 'hidden'): string {
	const isSelected = isTargetSelected(tab.selectedFrameId, target.frameId)
	const kindLabel = target.type === 'page' ? 'Page' : 'Iframe'
	const title = target.title || kindLabel
	const url = target.url || '(no url)'
	const visibilityAction = renderTargetVisibilityAction(tab.tabId, target, visibility)
	return `
    <div class="target-item ${isSelected ? 'selected' : ''} ${visibility === 'hidden' ? 'hidden-target' : ''}">
      <button
        class="target-select-action"
        data-action="select-target"
        data-tab-id="${tab.tabId}"
        data-frame-id="${escapeHtml(target.frameId ?? '')}"
        type="button"
        ${visibility === 'hidden' ? 'disabled' : ''}
      >
        <span class="target-kind">${kindLabel}</span>
        <span class="target-meta">
          <span class="target-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          <span class="target-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        </span>
      </button>
      ${visibilityAction}
    </div>
  `
}

function renderTargetVisibilityAction(tabId: number, target: PopupTarget, visibility: 'visible' | 'hidden'): string {
	if (target.type !== 'iframe' || !target.frameId) {
		return ''
	}

	const action = visibility === 'hidden' ? 'show-target' : 'hide-target'
	const label = visibility === 'hidden' ? 'Show iframe target' : 'Hide iframe target'
	const icon = visibility === 'hidden' ? SHOW_TARGET_ICON : HIDE_TARGET_ICON

	return `
		<button
			class="target-visibility-action"
			data-action="${action}"
			data-tab-id="${tabId}"
			data-frame-id="${escapeHtml(target.frameId)}"
			type="button"
			title="${label}"
			aria-label="${label}"
		>
			${icon}
		</button>
	`
}

function isTargetSelected(selectedFrameId: string | null | undefined, targetFrameId: string | null): boolean {
	return selectedFrameId !== undefined && (selectedFrameId ?? null) === (targetFrameId ?? null)
}

function escapeHtml(text: string): string {
	const div = document.createElement('div')
	div.textContent = text
	return div.innerHTML
}
