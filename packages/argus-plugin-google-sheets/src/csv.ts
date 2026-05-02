/** Parse RFC4180-style CSV into rows of strings. */
export const parseCsv = (input: string): string[][] => {
	const rows: string[][] = []
	let row: string[] = []
	let cell = ''
	let quoted = false

	for (let i = 0; i < input.length; i++) {
		const char = input[i]
		const next = input[i + 1]

		if (quoted) {
			if (char === '"' && next === '"') {
				cell += '"'
				i++
			} else if (char === '"') {
				quoted = false
			} else {
				cell += char
			}
			continue
		}

		if (char === '"') {
			quoted = true
		} else if (char === ',') {
			row.push(cell)
			cell = ''
		} else if (char === '\n') {
			row.push(cell)
			rows.push(row)
			row = []
			cell = ''
		} else if (char !== '\r') {
			cell += char
		}
	}

	row.push(cell)
	if (row.length > 1 || row[0] !== '' || input.endsWith(',')) {
		rows.push(row)
	}

	return rows
}

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
