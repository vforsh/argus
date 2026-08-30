import { buildPageExpression } from './pageExpression.js'
import {
	delay,
	dispatchPointerEvent,
	findRenderedElement,
	getRenderedElements,
	getSpreadsheetId,
	pressElement,
	sheetDomDeps,
} from './sheetDataPageScripts.js'

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
}): string =>
	buildPageExpression(mutateDimensionInPage, input, [
		...sheetDomDeps,
		pressInsertDimensionMenuItem,
		resolveInsertDirection,
		pressRemoveDimensionMenuItem,
		openTopMenu,
		openSubmenu,
		pressMenuItemMatching,
		normalizeMenuText,
		waitForMenuItemMatching,
	])

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
