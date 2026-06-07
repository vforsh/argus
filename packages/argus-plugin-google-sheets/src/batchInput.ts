import { readFile } from 'node:fs/promises'
import type { Output } from './sheetCommandUtils.js'

export type BatchOperation =
	| {
			range: string
			values: string[][]
			sheet?: string
			verify?: boolean
	  }
	| {
			range: string
			clear: true
			sheet?: string
			verify?: boolean
	  }

type BatchInputOptions = {
	file?: string
	stdin?: boolean
}

export const loadBatchOperations = async (
	options: BatchInputOptions,
	output: Output,
	readStdin: () => Promise<string>,
): Promise<BatchOperation[] | null> => {
	const selected = [options.file != null, options.stdin === true].filter(Boolean).length
	if (selected !== 1) {
		output.writeWarn('Provide exactly one of --file or --stdin')
		process.exitCode = 2
		return null
	}

	let parsed: unknown
	try {
		const text = options.file ? await readFile(options.file, 'utf8') : await readStdin()
		parsed = JSON.parse(text)
	} catch (error) {
		output.writeWarn(`Failed to read batch JSON: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return null
	}

	if (!Array.isArray(parsed)) {
		output.writeWarn('Batch JSON must be an array')
		process.exitCode = 2
		return null
	}

	const operations: BatchOperation[] = []
	for (let index = 0; index < parsed.length; index++) {
		const operation = parseBatchOperation(parsed[index], index)
		if (typeof operation === 'string') {
			output.writeWarn(operation)
			process.exitCode = 2
			return null
		}
		operations.push(operation)
	}
	return operations
}

const parseBatchOperation = (value: unknown, index: number): BatchOperation | string => {
	if (!isRecord(value)) return `Batch operation #${index + 1} must be an object`
	if (typeof value.range !== 'string' || value.range.trim() === '') return `Batch operation #${index + 1} must include a non-empty string range`
	if (value.sheet != null && (typeof value.sheet !== 'string' || value.sheet.trim() === '')) {
		return `Batch operation #${index + 1} sheet must be a non-empty string`
	}
	if (value.verify != null && typeof value.verify !== 'boolean') return `Batch operation #${index + 1} verify must be a boolean`
	const sheet = typeof value.sheet === 'string' ? value.sheet : undefined
	const verify = typeof value.verify === 'boolean' ? value.verify : undefined

	const hasValues = Object.hasOwn(value, 'values')
	const hasClear = value.clear === true
	if ([hasValues, hasClear].filter(Boolean).length !== 1) {
		return `Batch operation #${index + 1} must include exactly one of values or clear: true`
	}

	if (hasClear) return { range: value.range, sheet, clear: true, verify }
	if (!Array.isArray(value.values) || value.values.length === 0) return `Batch operation #${index + 1} values must be a non-empty string[][]`

	const rows: string[][] = []
	for (let rowIndex = 0; rowIndex < value.values.length; rowIndex++) {
		const row = value.values[rowIndex]
		if (!Array.isArray(row)) return `Batch operation #${index + 1} values row #${rowIndex + 1} must be an array`
		const cells: string[] = []
		for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
			const cell = row[columnIndex]
			if (typeof cell !== 'string') {
				return `Batch operation #${index + 1} values cell R${rowIndex + 1}C${columnIndex + 1} must be a string`
			}
			cells.push(cell)
		}
		rows.push(cells)
	}
	return { range: value.range, sheet, values: rows, verify }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
