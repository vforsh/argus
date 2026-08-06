import type { SheetInfoResult, SheetTab } from './sheetTabsTypes.js'

/** Format a plain fixed-width table for human CLI output. */
export const formatTable = (rows: string[][]): string => {
	if (rows.length === 0) return ''
	const widths = rows[0].map((_, index) => Math.min(48, Math.max(...rows.map((row) => (row[index] ?? '').length))))
	return rows
		.map((row) =>
			row
				.map((cell, index) => cell.padEnd(widths[index] ?? 0))
				.join('  ')
				.trimEnd(),
		)
		.join('\n')
}

/** Format visible sheet tabs for human CLI output. */
export const formatSheetList = (sheets: SheetTab[]): string => {
	if (sheets.length === 0) return 'No visible sheets'
	const rows = sheets.map((sheet) => [sheet.active ? '*' : ' ', String(sheet.index), sheet.name, sheet.gid ?? ''])
	return formatTable([['', '#', 'Name', 'gid'], ...rows])
}

/** Format spreadsheet info for human CLI output. */
export const formatSheetInfo = (info: SheetInfoResult): string =>
	[
		`Title: ${info.title}`,
		`Spreadsheet: ${info.spreadsheetId}`,
		`Active: ${info.active ? formatSheetLabel(info.active) : 'none'}`,
		'',
		formatSheetList(info.sheets),
	].join('\n')

/** Format one sheet name with an available gid. */
export const formatSheetLabel = (sheet: SheetTab): string => (sheet.gid ? `${sheet.name} (${sheet.gid})` : sheet.name)
