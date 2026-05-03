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

export type SheetListResult = {
	ok: true
	title: string
	url: string
	activeGid: string
	sheets: SheetTab[]
}

export type SheetSwitchResult = {
	ok: true
	title: string
	url: string
	sheet: SheetTab
}

export type SheetClipboardResult = {
	ok: true
	method: string
}

export const buildReadCsvExpression = (input: { range?: string; gid?: string }): string =>
	`(${readSheetCsvInPage.toString()})(${JSON.stringify(input)})`

export const buildListSheetsExpression = (input: { withGid?: boolean }): string => buildSheetTabsExpression(listSheetsInPage, input)

export const buildSwitchSheetExpression = (target: string): string => buildSheetTabsExpression(switchSheetInPage, { target })

export const buildSelectRangeExpression = (range: string): string => `(${selectSheetRangeInPage.toString()})(${JSON.stringify({ range })})`

export const buildClipboardExpression = (text: string): string => `(${writeClipboardInPage.toString()})(${JSON.stringify({ text })})`

const sheetTabHelpers = [
	collectSheetTabs,
	collectSheetTabsWithGids,
	resolveSheetTab,
	getVisibleSheetTabs,
	getActiveSheetTab,
	isRenderedElement,
	getCurrentGid,
	findVisibleGridGid,
	resolveSheetTabByIndex,
	resolveSheetTabByName,
	resolveSheetTabByGid,
	activateSheetTab,
	pressSheetTab,
	waitForSheetTabActivation,
	stripSheetTabElement,
	delay,
]

// Sheet-tab commands run as a single browser eval, so every helper they call must be embedded into the expression.
const buildSheetTabsExpression = <T>(fn: (input: T) => Promise<unknown>, input: T): string => `(() => {
${sheetTabHelpers.map((helper) => helper.toString()).join('\n')}
return (${fn.toString()})(${JSON.stringify(input)})
})()`

function readSheetCsvInPage(input: { range?: string; gid?: string }): Promise<SheetCsvResult> {
	const getSpreadsheetId = (): string => {
		const match = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
		if (!match) throw new Error('Current page is not a Google Sheets document.')
		return match[1]
	}

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

async function switchSheetInPage(input: { target: string }): Promise<SheetSwitchResult> {
	const trimmed = input.target.trim()
	if (!trimmed) throw new Error('Sheet target must not be empty.')

	const visibleTabs = getVisibleSheetTabs()
	const tab = await resolveSheetTab(visibleTabs, trimmed)
	if (tab) return await activateSheetTab(tab)
	throw new Error(`No visible sheet matched "${trimmed}".`)
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

async function resolveSheetTab(tabs: SheetTabElement[], target: string): Promise<SheetTabElement | null> {
	return resolveSheetTabByIndex(tabs, target) ?? resolveSheetTabByName(tabs, target) ?? (await resolveSheetTabByGid(tabs, target))
}

function getVisibleSheetTabs(): SheetTabElement[] {
	const activeGid = getCurrentGid()
	return Array.from(document.querySelectorAll<HTMLElement>('.docs-sheet-tab'))
		.filter(isRenderedElement)
		.map((element, index) => {
			const name = element.querySelector<HTMLElement>('.docs-sheet-tab-name')?.textContent?.trim() ?? element.textContent.trim()
			const active = element.classList.contains('docs-sheet-active-tab')
			return { index: index + 1, name, gid: active ? activeGid : null, active, element }
		})
		.filter((tab) => tab.name.length > 0)
}

function getActiveSheetTab(): SheetTabElement | null {
	return getVisibleSheetTabs().find((tab) => tab.active) ?? null
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
	for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
		element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
	}
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
