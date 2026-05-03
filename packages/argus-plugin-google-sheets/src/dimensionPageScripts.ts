export type SheetDimensionMutationResult = {
	ok: true
	title: string
	url: string
	action: 'add' | 'remove'
	dimension: 'rows' | 'columns'
	index: number
	count: number
	side: 'before' | 'after' | null
	range: string
	menuItem: string
}

export const buildDimensionMutationExpression = (input: {
	action: 'add' | 'remove'
	dimension: 'rows' | 'columns'
	index: number
	count: number
	side?: 'before' | 'after'
	range: string
}): string => `(() => {
${[
	getSpreadsheetId,
	getRenderedElements,
	findRenderedElement,
	isRenderedElement,
	pressElement,
	pressInsertDimensionMenuItem,
	resolveInsertDirection,
	pressRemoveDimensionMenuItem,
	openTopMenu,
	openSubmenu,
	dispatchPointerEvent,
	pressMenuItemMatching,
	normalizeMenuText,
	waitForMenuItemMatching,
	delay,
]
	.map((helper) => helper.toString())
	.join('\n')}
${mutateDimensionInPage.toString()}
return mutateDimensionInPage(${JSON.stringify(input)})
})()`

async function mutateDimensionInPage(input: {
	action: 'add' | 'remove'
	dimension: 'rows' | 'columns'
	index: number
	count: number
	side?: 'before' | 'after'
	range: string
}): Promise<SheetDimensionMutationResult> {
	getSpreadsheetId()

	const item =
		input.action === 'add' ? await pressInsertDimensionMenuItem(input.dimension, input.side) : await pressRemoveDimensionMenuItem(input.dimension)

	await delay(300)
	return {
		ok: true,
		title: document.title,
		url: location.href,
		action: input.action,
		dimension: input.dimension,
		index: input.index,
		count: input.count,
		side: input.side ?? null,
		range: input.range,
		menuItem: item,
	}
}

async function pressInsertDimensionMenuItem(dimension: 'rows' | 'columns', side: 'before' | 'after' | undefined): Promise<string> {
	if (!side) throw new Error('Insert side is required.')

	openTopMenu('Insert')
	openSubmenu(dimension === 'rows' ? 'Rows' : 'Columns')

	const direction = resolveInsertDirection(dimension, side)
	return await pressMenuItemMatching([new RegExp(`^Insert \\d+ ${dimension.slice(0, -1)}s? ${direction}\\b`, 'i')])
}

function resolveInsertDirection(dimension: 'rows' | 'columns', side: 'before' | 'after'): 'above' | 'below' | 'left' | 'right' {
	if (dimension === 'rows') return side === 'before' ? 'above' : 'below'
	return side === 'before' ? 'left' : 'right'
}

async function pressRemoveDimensionMenuItem(dimension: 'rows' | 'columns'): Promise<string> {
	openTopMenu('Edit')
	openSubmenu('Delete')
	const singular = dimension.slice(0, -1)
	return await pressMenuItemMatching([
		new RegExp(`^Delete ${dimension}\\b`, 'i'),
		new RegExp(`^${singular}\\b`, 'i'),
		new RegExp(`^${dimension}\\b`, 'i'),
	])
}

function openTopMenu(label: 'Insert' | 'Edit'): void {
	const id = label === 'Insert' ? '#docs-insert-menu' : '#docs-edit-menu'
	const menu = findRenderedElement(id)
	if (!menu) throw new Error(`Google Sheets ${label} menu was not found.`)
	pressElement(menu)
}

function openSubmenu(label: string): void {
	const item = getRenderedElements('[role="menuitem"], .goog-menuitem').find((element) => normalizeMenuText(element).startsWith(label))
	if (!item) throw new Error(`Google Sheets menu item "${label}" was not found.`)

	const rect = item.getBoundingClientRect()
	for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
		dispatchPointerEvent(item, type, rect.right - 8, rect.top + rect.height / 2)
	}
}

function dispatchPointerEvent(element: HTMLElement, type: string, clientX: number, clientY: number, button: 0 | 2 = 0): void {
	element.dispatchEvent(
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			view: window,
			clientX,
			clientY,
			button,
		}),
	)
}

async function pressMenuItemMatching(patterns: RegExp[]): Promise<string> {
	const item = await waitForMenuItemMatching(patterns)
	const text = normalizeMenuText(item)
	pressElement(item)
	return text
}

async function waitForMenuItemMatching(patterns: RegExp[]): Promise<HTMLElement> {
	const deadline = Date.now() + 3_000
	while (Date.now() < deadline) {
		const item = getRenderedElements('[role="menuitem"], .goog-menuitem').find((element) => {
			if (element.classList.contains('goog-menuitem-disabled')) return false
			const text = normalizeMenuText(element)
			return patterns.some((pattern) => pattern.test(text))
		})
		if (item) return item
		await delay(50)
	}
	throw new Error(`Google Sheets menu item matching ${patterns.map((pattern) => pattern.source).join(' or ')} was not found.`)
}

function normalizeMenuText(element: HTMLElement): string {
	return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function getSpreadsheetId(): string {
	const match = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
	if (!match) throw new Error('Current page is not a Google Sheets document.')
	return match[1]
}

function getRenderedElements(selector: string): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isRenderedElement)
}

function findRenderedElement(selector: string): HTMLElement | null {
	return getRenderedElements(selector)[0] ?? null
}

function isRenderedElement(element: HTMLElement): boolean {
	const rect = element.getBoundingClientRect()
	const style = getComputedStyle(element)
	return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
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
		dispatchPointerEvent(element, type, eventInit.clientX, eventInit.clientY, eventInit.button)
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
