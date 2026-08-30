import { parseCsvInPage } from './sheetDataPageScripts.js'

/**
 * Parse RFC4180-style CSV into rows of strings.
 *
 * Re-exported from the page-side parser rather than reimplemented: the two were the same
 * ~45-line algorithm differing only in variable names and brace style, and the page one
 * has to stay serializable, so it is the one that cannot be simplified away.
 */
export const parseCsv = parseCsvInPage

/** Convert a rectangular string table to TSV for Google Sheets paste. */
export const toTsv = (rows: readonly (readonly string[])[]): string =>
	rows.map((row) => row.map((value) => value.replace(/\r?\n/g, ' ')).join('\t')).join('\n')

/** Parse TSV into rows of strings. */
export const parseTsv = (input: string): string[][] =>
	input
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n')
		.map((line) => line.split('\t'))
