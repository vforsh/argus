#!/usr/bin/env bun
/**
 * Re-record a compact-table fixture from a live Google Sheets tab.
 *
 * Usage: `bun run capture-compact <watcher> <range> [outputPath] [--note "…"]`
 *
 * Drives exactly the steps `readTypedMatrix` drives — select, install the copy listener, Ctrl+C,
 * read the capture — through the `argus` CLI, then parses the result so a recording that the decoder
 * cannot read fails here instead of in a test. The spreadsheet id never appears in the payload, so
 * the written file needs no sanitizing.
 *
 * @example bun run capture-compact extension 'A1:E5' test/fixtures/compact/rect-5x5.json
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseA1Range } from '../src/a1.js'
import { parseCompactTable } from '../src/compactTable.js'
import { buildSelectRangeExpression } from '../src/pageScripts.js'
import { buildInstallCopyCaptureExpression, buildReadCopyCaptureExpression } from '../src/rawCellValues.js'

const [watcher, range, outputPath] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const noteIndex = process.argv.indexOf('--note')
const note = noteIndex >= 0 ? (process.argv[noteIndex + 1] ?? '') : ''

if (!watcher || !range) {
	console.error('Usage: bun run capture-compact <watcher> <range> [outputPath] [--note "…"]')
	process.exit(2)
}
const bounds = parseA1Range(range)
if (!bounds) {
	console.error(`Expected an A1 cell range, got ${range}.`)
	process.exit(2)
}

const argus = (args: string[], stdin?: string): string => execFileSync('argus', args, { input: stdin, encoding: 'utf8' })
const evaluate = (expression: string): unknown => {
	const response = JSON.parse(argus(['eval', watcher, '--stdin', '--json'], expression)) as { exception: unknown; result: unknown }
	if (response.exception) throw new Error(`Page evaluation failed: ${JSON.stringify(response.exception)}`)
	return response.result
}

const token = randomUUID()
evaluate(buildSelectRangeExpression(range))
argus(['keydown', watcher, '--key', 'Enter', '--selector', '#t-name-box'])
await Bun.sleep(200)
evaluate(buildInstallCopyCaptureExpression(token))
argus(['keydown', watcher, '--key', 'c', '--ctrl'])
const capture = evaluate(buildReadCopyCaptureExpression(token)) as { compact: string; text: string }

const fixture = {
	note,
	range,
	rows: bounds.endRow - bounds.startRow + 1,
	columns: bounds.endColumn - bounds.startColumn + 1,
	compact: capture.compact,
	text: capture.text,
}
// Prove the recording is readable before it becomes a fixture other tests trust.
const cells = parseCompactTable(capture)
if (cells.length !== fixture.rows || cells[0].length !== fixture.columns) {
	throw new Error(`Copied a ${cells.length}x${cells[0].length} rectangle, expected ${fixture.rows}x${fixture.columns}.`)
}

const serialized = `${JSON.stringify(fixture, null, '\t')}\n`
if (!outputPath) {
	console.log(serialized)
} else {
	mkdirSync(dirname(outputPath), { recursive: true })
	writeFileSync(outputPath, serialized, 'utf8')
	console.log(`Wrote ${outputPath}: ${fixture.rows}x${fixture.columns}, ${capture.compact.length} payload bytes.`)
}
