/** Authenticated CSV read result with explicit target and browser metadata. */
export type SheetCsvResult = {
	ok: true
	title: string
	targetGid: string
	targetUrl: string
	browserCurrentGid: string
	browserCurrentUrl: string
	range: string | null
	csv: string
}

/** Google Sheets name-box selection result. */
export type SheetSelectResult = { ok: true; range: string; nameBoxValue: string }

/** Browser clipboard preparation result. */
export type SheetClipboardResult = { ok: true; method: string }

/** Build a browser expression for an authenticated CSV read. */
export const buildReadCsvExpression = (input: { range?: string; gid?: string }): string => `(() => {
${[getSpreadsheetId, getCurrentGid, findVisibleGridGid, isRenderedElement, canonicalSheetUrl, readSheetCsvInPage].map((helper) => helper.toString()).join('\n')}
return readSheetCsvInPage(${JSON.stringify(input)})
})()`

/** Build a browser expression that fills the Google Sheets name box. */
export const buildSelectRangeExpression = (range: string): string => `(${selectSheetRangeInPage.toString()})(${JSON.stringify({ range })})`

/** Build a browser expression that replaces the clipboard text. */
export const buildClipboardExpression = (text: string): string => `(${writeClipboardInPage.toString()})(${JSON.stringify({ text })})`

/** Read Google Sheets CSV inside its authenticated page context. */
export function readSheetCsvInPage(input: { range?: string; gid?: string }): Promise<SheetCsvResult> {
	const gid = input.gid ?? getCurrentGid()
	const id = getSpreadsheetId()
	const params = new URLSearchParams({ tqx: 'out:csv', gid })
	if (input.range) params.set('range', input.range)
	return fetch(`${location.origin}/spreadsheets/d/${id}/gviz/tq?${params.toString()}`, { credentials: 'include' }).then(async (response) => {
		const csv = await response.text()
		if (!response.ok) throw new Error(`Google Sheets CSV export failed: HTTP ${response.status} ${csv.slice(0, 200)}`)
		return {
			ok: true,
			title: document.title,
			targetGid: gid,
			targetUrl: canonicalSheetUrl(location.href, gid),
			browserCurrentGid: getCurrentGid(),
			browserCurrentUrl: location.href,
			range: input.range ?? null,
			csv,
		}
	})
}

/** Fill the live Google Sheets name box. The caller dispatches native Enter separately. */
export async function selectSheetRangeInPage(input: { range: string }): Promise<SheetSelectResult> {
	const nameBox = document.querySelector<HTMLInputElement>('#t-name-box')
	if (!nameBox) throw new Error('Google Sheets name box (#t-name-box) was not found.')
	nameBox.focus()
	nameBox.value = input.range
	nameBox.dispatchEvent(new Event('input', { bubbles: true }))
	nameBox.dispatchEvent(new Event('change', { bubbles: true }))
	return { ok: true, range: input.range, nameBoxValue: nameBox.value }
}

/** Parse RFC4180-like CSV inside a serialized page expression. */
export function parseCsvInPage(input: string): string[][] {
	const rows: string[][] = []
	let row: string[] = []
	let cell = ''
	let quoted = false
	for (let index = 0; index < input.length; index++) {
		const character = input[index]
		const next = input[index + 1]
		if (quoted) {
			if (character === '"' && next === '"') {
				cell += '"'
				index++
			} else if (character === '"') quoted = false
			else cell += character
			continue
		}
		if (character === '"') quoted = true
		else if (character === ',') {
			row.push(cell)
			cell = ''
		} else if (character === '\n') {
			row.push(cell)
			rows.push(row)
			row = []
			cell = ''
		} else if (character !== '\r') cell += character
	}
	row.push(cell)
	if (row.length > 1 || row[0] !== '' || input.endsWith(',')) rows.push(row)
	return rows
}

/** Extract the current sheet gid, preferring the rendered grid over possibly lagging URL state. */
export function getCurrentGid(): string {
	return findVisibleGridGid() ?? new URL(location.href).searchParams.get('gid') ?? location.hash.match(/gid=([^&]+)/)?.[1] ?? '0'
}

/** Extract a Google Sheets spreadsheet id from the current page. */
export function getSpreadsheetId(): string {
	const match = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
	if (!match) throw new Error('Current page is not a Google Sheets document.')
	return match[1]
}

/** Return the gid encoded by the currently rendered grid. */
export function findVisibleGridGid(): string | null {
	const grid = Array.from(document.querySelectorAll<HTMLElement>('[id$="-grid-container"]')).find(isRenderedElement)
	return grid?.id.match(/^(\d+)-grid-container$/)?.[1] ?? null
}

/** Test whether a DOM element is the rendered live copy Google Sheets currently uses. */
export function isRenderedElement(element: HTMLElement): boolean {
	const rect = element.getBoundingClientRect()
	const style = getComputedStyle(element)
	return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

/** Build a canonical target-sheet URL without claiming it is the browser's current URL. */
export function canonicalSheetUrl(currentUrl: string, gid: string): string {
	const url = new URL(currentUrl)
	url.searchParams.set('gid', gid)
	url.hash = `gid=${encodeURIComponent(gid)}`
	return url.toString()
}

/** Delay helper safe to serialize into browser expressions. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Replace clipboard text through a scoped temporary textarea; reject empty writes to prevent stale clipboard paste. */
export async function writeClipboardInPage(input: { text: string }): Promise<SheetClipboardResult> {
	if (input.text === '') throw new Error('Refusing an empty clipboard write; use native clear.')
	const textarea = document.createElement('textarea')
	try {
		textarea.value = input.text
		textarea.style.position = 'fixed'
		textarea.style.left = '-10000px'
		document.body.append(textarea)
		textarea.focus()
		textarea.select()
		if (!document.execCommand('copy')) throw new Error('Failed to replace the clipboard text.')
		return { ok: true, method: 'document.execCommand(copy)' }
	} finally {
		textarea.remove()
	}
}
