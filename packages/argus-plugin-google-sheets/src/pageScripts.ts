export type SheetCsvResult = {
	ok: true
	title: string
	url: string
	gid: string
	range: string | null
	csv: string
}

export type SheetSelectResult = {
	ok: true
	range: string
	nameBoxValue: string
}

export type SheetTab = {
	index: number
	name: string
	gid: string | null
	active: boolean
}

type SheetPageResult = {
	ok: true
	title: string
	url: string
}

export type SheetListResult = SheetPageResult & {
	activeGid: string
	sheets: SheetTab[]
}

export type SheetInfoResult = SheetListResult & {
	spreadsheetId: string
	active: SheetTab | null
}

export type SheetSwitchResult = SheetPageResult & {
	sheet: SheetTab
}

export type SheetAddResult = SheetPageResult & {
	sheet: SheetTab
}

export type SheetRemoveResult = SheetPageResult & {
	removed: SheetTab
	active: SheetTab | null
}

export type SheetRenameResult = SheetPageResult & {
	before: SheetTab
	sheet: SheetTab
}

export type SheetMoveResult = SheetPageResult & {
	before: SheetTab
	sheet: SheetTab
}

export type SheetClipboardResult = {
	ok: true
	method: string
}

export const buildReadCsvExpression = (input: { range?: string; gid?: string }): string =>
	`(() => {
${getSpreadsheetId.toString()}
return (${readSheetCsvInPage.toString()})(${JSON.stringify(input)})
})()`

export const buildListSheetsExpression = (input: { withGid?: boolean }): string => buildSheetTabsExpression(listSheetsInPage, input)

export const buildInfoSheetsExpression = (input: { withGid?: boolean }): string => buildSheetTabsExpression(infoSheetsInPage, input)

export const buildSwitchSheetExpression = (target: string): string => buildSheetTabsExpression(switchSheetInPage, { target })

export const buildAddSheetExpression = (): string => buildSheetTabsExpression(addSheetInPage, {})

export const buildRemoveSheetExpression = (target: string): string => buildSheetTabsExpression(removeSheetInPage, { target })

export const buildRenameSheetExpression = (target: string, name: string): string => buildSheetTabsExpression(renameSheetInPage, { target, name })

export const buildMoveSheetExpression = (target: string, index: string): string => buildSheetTabsExpression(moveSheetInPage, { target, index })

export const buildSelectRangeExpression = (range: string): string => `(${selectSheetRangeInPage.toString()})(${JSON.stringify({ range })})`

export const buildClipboardExpression = (text: string): string => `(${writeClipboardInPage.toString()})(${JSON.stringify({ text })})`

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
	stripSheetTabElement,
	delay,
]

// Sheet-tab commands run as a single browser eval, so every helper they call must be embedded into the expression.
const buildSheetTabsExpression = <T>(fn: (input: T) => Promise<unknown>, input: T): string => `(() => {
${sheetTabHelpers.map((helper) => helper.toString()).join('\n')}
return (${fn.toString()})(${JSON.stringify(input)})
})()`

function readSheetCsvInPage(input: { range?: string; gid?: string }): Promise<SheetCsvResult> {
	const gid = input.gid ?? new URL(location.href).searchParams.get('gid') ?? location.hash.match(/gid=([^&]+)/)?.[1] ?? '0'
	const id = getSpreadsheetId()
	const params = new URLSearchParams({ tqx: 'out:csv', gid })
	if (input.range) params.set('range', input.range)

	return fetch(`${location.origin}/spreadsheets/d/${id}/gviz/tq?${params.toString()}`, { credentials: 'include' }).then(async (response) => {
		const csv = await response.text()
		if (!response.ok) {
			throw new Error(`Google Sheets CSV export failed: HTTP ${response.status} ${csv.slice(0, 200)}`)
		}
		return { ok: true, title: document.title, url: location.href, gid, range: input.range ?? null, csv }
	})
}

async function listSheetsInPage(input: { withGid?: boolean }): Promise<SheetListResult> {
	const originalGid = getCurrentGid()
	const originalTab = getActiveSheetTab()
	const sheets = input.withGid ? await collectSheetTabsWithGids(originalTab, originalGid) : collectSheetTabs()
	return { ok: true, title: document.title, url: location.href, activeGid: originalGid, sheets }
}

async function infoSheetsInPage(input: { withGid?: boolean }): Promise<SheetInfoResult> {
	const result = await listSheetsInPage(input)
	return { ...result, spreadsheetId: getSpreadsheetId(), active: result.sheets.find((sheet) => sheet.active) ?? null }
}

async function switchSheetInPage(input: { target: string }): Promise<SheetSwitchResult> {
	return await activateSheetTab(await resolveRequiredSheetTab(input.target))
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

async function selectSheetRangeInPage(input: { range: string }): Promise<SheetSelectResult> {
	const nameBox = document.querySelector<HTMLInputElement>('#t-name-box')
	if (!nameBox) throw new Error('Google Sheets name box (#t-name-box) was not found.')

	nameBox.focus()
	nameBox.value = input.range
	nameBox.dispatchEvent(new Event('input', { bubbles: true }))
	nameBox.dispatchEvent(new Event('change', { bubbles: true }))

	return { ok: true, range: input.range, nameBoxValue: nameBox.value }
}

type SheetTabElement = SheetTab & {
	element: HTMLElement
}

function collectSheetTabs(): SheetTab[] {
	return getVisibleSheetTabs().map((tab) => stripSheetTabElement(tab))
}

async function collectSheetTabsWithGids(originalTab: SheetTabElement | null, originalGid: string): Promise<SheetTab[]> {
	const tabs = getVisibleSheetTabs()
	const sheets: SheetTab[] = []
	try {
		for (const tab of tabs) {
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
	return resolveSheetTabByIndex(tabs, target) ?? resolveSheetTabByName(tabs, target) ?? (await resolveSheetTabByGid(tabs, target))
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
	return { index: index + 1, name, gid: active ? activeGid : null, active, element }
}

function isRenderedElement(element: HTMLElement): boolean {
	// Google keeps duplicate sheet-tab DOM around; geometry is the stable signal for the live tab bar.
	const rect = element.getBoundingClientRect()
	const style = getComputedStyle(element)
	return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

function getCurrentGid(): string {
	return new URL(location.href).searchParams.get('gid') ?? location.hash.match(/gid=([^&]+)/)?.[1] ?? findVisibleGridGid() ?? '0'
}

function getSpreadsheetId(): string {
	const match = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
	if (!match) throw new Error('Current page is not a Google Sheets document.')
	return match[1]
}

function findVisibleGridGid(): string | null {
	const grid = Array.from(document.querySelectorAll<HTMLElement>('[id$="-grid-container"]')).find(isRenderedElement)
	return grid?.id.match(/^(\d+)-grid-container$/)?.[1] ?? null
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

	const originalTab = getActiveSheetTab()
	for (const tab of tabs) {
		const activated = await activateSheetTab(tab)
		if (activated.sheet.gid === target) {
			return getActiveSheetTab() ?? tab
		}
	}
	if (originalTab) await activateSheetTab(originalTab)
	return null
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeClipboardInPage(input: { text: string }): Promise<SheetClipboardResult> {
	const textarea = document.createElement('textarea')
	textarea.value = input.text
	textarea.style.position = 'fixed'
	textarea.style.left = '-10000px'
	document.body.append(textarea)
	textarea.focus()
	textarea.select()
	const copied = document.execCommand('copy')
	textarea.remove()
	if (!copied) throw new Error('Failed to copy TSV into clipboard.')
	return { ok: true, method: 'document.execCommand(copy)' }
}
