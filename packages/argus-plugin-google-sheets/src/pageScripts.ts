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

export type SheetClipboardResult = {
	ok: true
	method: string
}

export const buildReadCsvExpression = (input: { range?: string; gid?: string }): string =>
	`(${readSheetCsvInPage.toString()})(${JSON.stringify(input)})`

export const buildSelectRangeExpression = (range: string): string => `(${selectSheetRangeInPage.toString()})(${JSON.stringify({ range })})`

export const buildClipboardExpression = (text: string): string => `(${writeClipboardInPage.toString()})(${JSON.stringify({ text })})`

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

async function selectSheetRangeInPage(input: { range: string }): Promise<SheetSelectResult> {
	const nameBox = document.querySelector<HTMLInputElement>('#t-name-box')
	if (!nameBox) throw new Error('Google Sheets name box (#t-name-box) was not found.')

	nameBox.focus()
	nameBox.value = input.range
	nameBox.dispatchEvent(new Event('input', { bubbles: true }))
	nameBox.dispatchEvent(new Event('change', { bubbles: true }))

	return { ok: true, range: input.range, nameBoxValue: nameBox.value }
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
