import { canonicalSheetUrl, delay, findVisibleGridGid, getCurrentGid, getSpreadsheetId, isRenderedElement } from './sheetDataPageScripts.js'
import type {
	SheetAddResult,
	SheetInfoResult,
	SheetListResult,
	SheetMoveResult,
	SheetRemoveResult,
	SheetRenameResult,
	SheetResolveResult,
	SheetSwitchResult,
	SheetTab,
} from './sheetTabsTypes.js'

export * from './sheetDataPageScripts.js'
export * from './pageA1.js'
export * from './sheetTabsTypes.js'

export const buildListSheetsExpression = (input: { withGid?: boolean; maxTabs?: number; force?: boolean; deadlineMs?: number }): string =>
	buildSheetTabsExpression(listSheetsInPage, input)

export const buildInfoSheetsExpression = (input: { withGid?: boolean; maxTabs?: number; force?: boolean; deadlineMs?: number }): string =>
	buildSheetTabsExpression(infoSheetsInPage, input)

export const buildSwitchSheetExpression = (target: string): string => buildSheetTabsExpression(switchSheetInPage, { target })

export const buildAddSheetExpression = (): string => buildSheetTabsExpression(addSheetInPage, {})

export const buildRemoveSheetExpression = (target: string): string => buildSheetTabsExpression(removeSheetInPage, { target })

export const buildRenameSheetExpression = (target: string, name: string): string => buildSheetTabsExpression(renameSheetInPage, { target, name })

export const buildMoveSheetExpression = (target: string, index: string): string => buildSheetTabsExpression(moveSheetInPage, { target, index })

export const buildResolveSheetExpression = (target: string): string => buildSheetTabsExpression(resolveSheetInPage, { target })

const sheetTabHelpers = [
	listSheetsInPage,
	collectSheetTabs,
	collectSheetTabsWithGids,
	resolveRequiredSheetTab,
	resolveSheetTab,
	getVisibleSheetTabs,
	getActiveSheetTab,
	getRenderedElements,
	findRenderedElement,
	createSheetTabElement,
	extractSheetTabGid,
	isRenderedElement,
	getCurrentGid,
	findVisibleGridGid,
	resolveSheetTabByIndex,
	resolveSheetTabByName,
	resolveSheetTabByGid,
	activateSheetTab,
	pressSheetTab,
	pressElement,
	openSheetTabMenu,
	pressMenuItem,
	confirmDialog,
	waitForAddedSheet,
	waitForRemovedSheet,
	waitForSheetNameEditor,
	commitSheetName,
	waitForRenamedSheet,
	waitForMovedSheet,
	parseVisibleSheetIndex,
	findConfirmationButton,
	waitForSheetTabActivation,
	getSpreadsheetId,
	canonicalSheetUrl,
	stripSheetTabElement,
	delay,
]

// Sheet-tab commands run as a single browser eval, so every helper they call must be embedded into the expression.
const buildSheetTabsExpression = <T>(fn: (input: T) => Promise<unknown>, input: T): string => `(() => {
${sheetTabHelpers.map((helper) => helper.toString()).join('\n')}
return (${fn.toString()})(${JSON.stringify(input)})
})()`

async function listSheetsInPage(input: { withGid?: boolean; maxTabs?: number; force?: boolean; deadlineMs?: number }): Promise<SheetListResult> {
	const originalGid = getCurrentGid()
	const originalTab = getActiveSheetTab()
	const sheets = input.withGid
		? await collectSheetTabsWithGids(originalTab, originalGid, {
				maxTabs: input.maxTabs ?? 100,
				force: input.force === true,
				deadlineAt: Date.now() + Math.min(25_000, Math.max(1_000, input.deadlineMs ?? 20_000)),
			})
		: collectSheetTabs()
	return { ok: true, title: document.title, url: location.href, activeGid: originalGid, sheets }
}

async function infoSheetsInPage(input: { withGid?: boolean; maxTabs?: number; force?: boolean; deadlineMs?: number }): Promise<SheetInfoResult> {
	const result = await listSheetsInPage(input)
	return { ...result, spreadsheetId: getSpreadsheetId(), active: result.sheets.find((sheet) => sheet.active) ?? null }
}

async function switchSheetInPage(input: { target: string }): Promise<SheetSwitchResult> {
	return await activateSheetTab(await resolveRequiredSheetTab(input.target))
}

async function resolveSheetInPage(input: { target: string }): Promise<SheetResolveResult> {
	const originalGid = getCurrentGid()
	const originalTab = getActiveSheetTab()
	let sheet: SheetTab | null = null

	try {
		sheet = (await activateSheetTab(await resolveRequiredSheetTab(input.target))).sheet
	} finally {
		if (originalTab && getCurrentGid() !== originalGid) await activateSheetTab(originalTab)
	}

	if (!sheet?.gid) throw new Error(`No visible sheet matched "${input.target}".`)
	return {
		ok: true,
		title: document.title,
		url: location.href,
		sheet,
		target: { name: sheet.name, index: sheet.index, gid: sheet.gid, url: canonicalSheetUrl(location.href, sheet.gid) },
		browser: {
			currentGid: getCurrentGid(),
			currentUrl: location.href,
			restoredGid: getCurrentGid(),
			restoredUrl: location.href,
		},
	}
}

async function addSheetInPage(): Promise<SheetAddResult> {
	const beforeTabs = getVisibleSheetTabs()
	const addButton = findRenderedElement('.docs-sheet-add-button')
	if (!addButton) throw new Error('Google Sheets add-sheet button was not found.')

	pressElement(addButton)
	const sheet = await waitForAddedSheet(beforeTabs)
	return { ok: true, title: document.title, url: location.href, sheet }
}

async function removeSheetInPage(input: { target: string }): Promise<SheetRemoveResult> {
	const visibleTabs = getVisibleSheetTabs()
	if (visibleTabs.length <= 1) throw new Error('Cannot remove the only visible sheet.')

	const tab = await resolveRequiredSheetTab(input.target, visibleTabs)
	const selected = await activateSheetTab(tab)
	openSheetTabMenu(getActiveSheetTab()?.element ?? tab.element)
	pressMenuItem('Delete')
	await confirmDialog()
	const active = await waitForRemovedSheet(selected.sheet)

	return { ok: true, title: document.title, url: location.href, removed: selected.sheet, active }
}

async function renameSheetInPage(input: { target: string; name: string }): Promise<SheetRenameResult> {
	const name = input.name.trim()
	if (!name) throw new Error('New sheet name must not be empty.')

	const tab = await resolveRequiredSheetTab(input.target)
	const selected = await activateSheetTab(tab)
	openSheetTabMenu(getActiveSheetTab()?.element ?? tab.element)
	pressMenuItem('Rename')
	commitSheetName(await waitForSheetNameEditor(), name)
	const sheet = await waitForRenamedSheet(selected.sheet, name)

	return { ok: true, title: document.title, url: location.href, before: selected.sheet, sheet }
}

async function moveSheetInPage(input: { target: string; index: string }): Promise<SheetMoveResult> {
	const visibleTabs = getVisibleSheetTabs()
	const toIndex = parseVisibleSheetIndex(input.index, visibleTabs.length)
	const tab = await resolveRequiredSheetTab(input.target, visibleTabs)

	const selected = await activateSheetTab(tab)
	let active = getActiveSheetTab()
	if (!active) throw new Error('Active sheet tab was not found.')

	while (active.index !== toIndex) {
		openSheetTabMenu(active.element)
		pressMenuItem(active.index > toIndex ? 'Move left' : 'Move right')
		active = await waitForMovedSheet(selected.sheet, active.index)
	}

	return { ok: true, title: document.title, url: location.href, before: selected.sheet, sheet: stripSheetTabElement(active) }
}

type SheetTabElement = SheetTab & {
	element: HTMLElement
}

function collectSheetTabs(): SheetTab[] {
	return getVisibleSheetTabs().map((tab) => stripSheetTabElement(tab))
}

async function collectSheetTabsWithGids(
	originalTab: SheetTabElement | null,
	originalGid: string,
	options: { maxTabs: number; force: boolean; deadlineAt: number },
): Promise<SheetTab[]> {
	const tabs = getVisibleSheetTabs()
	if (tabs.length > options.maxTabs && !options.force) {
		throw new Error(
			`Refusing to activate ${tabs.length} sheets (guard: ${options.maxTabs}). Use --force with a bounded --deadline, or resolve a known name directly.`,
		)
	}
	const sheets: SheetTab[] = []
	try {
		for (const tab of tabs) {
			if (Date.now() >= options.deadlineAt) throw new Error(`Sheet gid traversal deadline reached after ${sheets.length}/${tabs.length} tabs.`)
			const activated = await activateSheetTab(tab)
			sheets.push({ ...activated.sheet, active: activated.sheet.gid === originalGid })
		}
		return sheets
	} finally {
		if (originalTab) await activateSheetTab(originalTab)
	}
}

async function resolveRequiredSheetTab(target: string, tabs = getVisibleSheetTabs()): Promise<SheetTabElement> {
	const trimmed = target.trim()
	if (!trimmed) throw new Error('Sheet target must not be empty.')

	const tab = await resolveSheetTab(tabs, trimmed)
	if (!tab) throw new Error(`No visible sheet matched "${trimmed}".`)
	return tab
}

async function resolveSheetTab(tabs: SheetTabElement[], target: string): Promise<SheetTabElement | null> {
	return resolveSheetTabByName(tabs, target) ?? (await resolveSheetTabByGid(tabs, target)) ?? resolveSheetTabByIndex(tabs, target)
}

function getVisibleSheetTabs(): SheetTabElement[] {
	const activeGid = getCurrentGid()
	return getRenderedElements('.docs-sheet-tab')
		.map((element, index) => createSheetTabElement(element, index, activeGid))
		.filter((tab) => tab.name.length > 0)
}

function getActiveSheetTab(): SheetTabElement | null {
	return getVisibleSheetTabs().find((tab) => tab.active) ?? null
}

function getRenderedElements(selector: string): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isRenderedElement)
}

function findRenderedElement(selector: string): HTMLElement | null {
	return getRenderedElements(selector)[0] ?? null
}

function createSheetTabElement(element: HTMLElement, index: number, activeGid: string): SheetTabElement {
	const name = element.querySelector<HTMLElement>('.docs-sheet-tab-name')?.textContent?.trim() ?? element.textContent.trim()
	const active = element.classList.contains('docs-sheet-active-tab')
	return { index: index + 1, name, gid: active ? activeGid : extractSheetTabGid(element), active, element }
}

function extractSheetTabGid(element: HTMLElement): string | null {
	for (const value of [element.dataset.sheetId, element.getAttribute('data-sheet-id'), element.id]) {
		const gid = value?.match(/(?:sheet-button-|^)(\d+)$/)?.[1]
		if (gid) return gid
	}
	return null
}

function resolveSheetTabByIndex(tabs: SheetTabElement[], target: string): SheetTabElement | null {
	const index = Number(target)
	if (!Number.isInteger(index) || index < 1 || index > tabs.length) return null
	return tabs[index - 1] ?? null
}

function resolveSheetTabByName(tabs: SheetTabElement[], target: string): SheetTabElement | null {
	const exact = tabs.filter((tab) => tab.name === target)
	if (exact.length === 1) return exact[0]
	if (exact.length > 1) throw new Error(`Multiple visible sheets are named "${target}". Use an index or gid.`)

	const foldedTarget = target.toLowerCase()
	const folded = tabs.filter((tab) => tab.name.toLowerCase() === foldedTarget)
	if (folded.length === 1) return folded[0]
	if (folded.length > 1) throw new Error(`Multiple visible sheets match "${target}". Use an index or gid.`)
	return null
}

async function resolveSheetTabByGid(tabs: SheetTabElement[], target: string): Promise<SheetTabElement | null> {
	if (!/^\d+$/.test(target)) return null
	if (target === getCurrentGid()) return getActiveSheetTab()
	const known = tabs.find((tab) => tab.gid === target)
	if (known) return known
	if (tabs.length > 100)
		throw new Error(`Refusing unbounded gid traversal across ${tabs.length} sheets. Resolve by sheet name or use sheets list --with-gid --force.`)
	const originalTab = getActiveSheetTab()
	const deadline = Date.now() + 20_000
	let found: SheetTabElement | null = null
	try {
		for (const tab of tabs) {
			if (Date.now() >= deadline) throw new Error(`Gid resolution deadline reached while searching for ${target}.`)
			const activated = await activateSheetTab(tab)
			if (activated.sheet.gid === target) {
				found = getActiveSheetTab() ?? tab
				break
			}
		}
	} finally {
		if (!found && originalTab && getCurrentGid() !== originalTab.gid) await activateSheetTab(originalTab)
	}
	return found
}

async function activateSheetTab(tab: SheetTabElement): Promise<SheetSwitchResult> {
	pressSheetTab(tab.element)
	await waitForSheetTabActivation(tab.name)
	const activeGid = getCurrentGid()
	return {
		ok: true,
		title: document.title,
		url: location.href,
		sheet: { index: tab.index, name: tab.name, gid: activeGid, active: true },
	}
}

function pressSheetTab(element: HTMLElement): void {
	element.scrollIntoView({ block: 'nearest', inline: 'center' })
	pressElement(element)
}

function pressElement(element: HTMLElement, button: 0 | 2 = 0): void {
	const rect = element.getBoundingClientRect()
	const eventInit = {
		bubbles: true,
		cancelable: true,
		view: window,
		clientX: rect.left + rect.width / 2,
		clientY: rect.top + rect.height / 2,
		button,
	}
	for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
		element.dispatchEvent(new MouseEvent(type, eventInit))
	}
}

function openSheetTabMenu(element: HTMLElement): void {
	element.scrollIntoView({ block: 'nearest', inline: 'center' })
	const rect = element.getBoundingClientRect()
	element.dispatchEvent(
		new MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			view: window,
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
			button: 2,
		}),
	)
}

function pressMenuItem(label: string): void {
	const item = getRenderedElements('[role="menuitem"]').find((element) => element.textContent?.trim() === label)
	if (!item) throw new Error(`Google Sheets menu item "${label}" was not found.`)
	pressElement(item)
}

async function confirmDialog(): Promise<void> {
	const deadline = Date.now() + 3_000
	while (Date.now() < deadline) {
		const button = findConfirmationButton()
		if (button) {
			pressElement(button)
			return
		}
		await delay(50)
	}
	throw new Error('Timed out waiting for the Google Sheets confirmation dialog.')
}

function findConfirmationButton(): HTMLElement | null {
	return (
		getRenderedElements('[role="button"], button').find((element) => {
			const text = element.textContent?.trim().toLowerCase()
			const aria = element.getAttribute('aria-label')?.trim().toLowerCase()
			return text === 'ok' || text === 'delete' || aria === 'ok' || aria === 'delete'
		}) ?? null
	)
}

async function waitForAddedSheet(beforeTabs: SheetTabElement[]): Promise<SheetTab> {
	const beforeNames = new Set(beforeTabs.map((tab) => tab.name))
	const beforeCount = beforeTabs.length
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		await delay(100)
		const active = getActiveSheetTab()
		const tabs = getVisibleSheetTabs()
		if (active && (tabs.length > beforeCount || !beforeNames.has(active.name))) return stripSheetTabElement(active)
	}
	throw new Error('Timed out waiting for Google Sheets to add a sheet.')
}

async function waitForRemovedSheet(removed: SheetTab): Promise<SheetTab | null> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		await delay(100)
		const tabs = getVisibleSheetTabs()
		const stillVisible = tabs.some((tab) => tab.name === removed.name && tab.gid === removed.gid)
		const active = getActiveSheetTab()
		if (!stillVisible) return active ? stripSheetTabElement(active) : null
	}
	throw new Error(`Timed out waiting for Google Sheets to remove "${removed.name}".`)
}

async function waitForSheetNameEditor(): Promise<HTMLElement> {
	const deadline = Date.now() + 3_000
	while (Date.now() < deadline) {
		const editor = document.querySelector<HTMLElement>('.docs-sheet-tab.docs-sheet-active-tab.docs-sheet-tab-edit .docs-sheet-tab-name')
		if (editor && isRenderedElement(editor)) return editor
		await delay(50)
	}
	throw new Error('Timed out waiting for the Google Sheets sheet-name editor.')
}

function commitSheetName(editor: HTMLElement, name: string): void {
	editor.focus()
	editor.textContent = name
	editor.dispatchEvent(new Event('input', { bubbles: true }))
	editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
	editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }))
}

async function waitForRenamedSheet(before: SheetTab, name: string): Promise<SheetTab> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		await delay(100)
		const active = getActiveSheetTab()
		if (active?.name === name && (before.gid == null || active.gid === before.gid)) return stripSheetTabElement(active)
	}
	throw new Error(`Timed out waiting for Google Sheets to rename "${before.name}" to "${name}".`)
}

async function waitForMovedSheet(sheet: SheetTab, previousIndex: number): Promise<SheetTabElement> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		await delay(100)
		const active = getActiveSheetTab()
		if (active && active.index !== previousIndex && (sheet.gid == null || active.gid === sheet.gid)) return active
	}
	throw new Error(`Timed out waiting for Google Sheets to move "${sheet.name}".`)
}

function parseVisibleSheetIndex(value: string, max: number): number {
	const index = Number(value)
	if (!Number.isInteger(index) || index < 1 || index > max) throw new Error(`Move index must be a visible sheet index between 1 and ${max}.`)
	return index
}

async function waitForSheetTabActivation(name: string): Promise<void> {
	const deadline = Date.now() + 3_000
	while (Date.now() < deadline) {
		await delay(50)
		const active = getVisibleSheetTabs().find((tab) => tab.active)
		if (active?.name === name) return
	}
	throw new Error(`Timed out waiting for sheet "${name}" to become active.`)
}

function stripSheetTabElement(tab: SheetTabElement): SheetTab {
	return { index: tab.index, name: tab.name, gid: tab.gid, active: tab.active }
}
