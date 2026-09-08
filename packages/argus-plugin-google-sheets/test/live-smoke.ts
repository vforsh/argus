#!/usr/bin/env bun
/**
 * End-to-end smoke run against a real Google Sheets tab.
 *
 * Usage: `bun run --cwd packages/argus-plugin-google-sheets smoke <watcher> <sheetName>`
 *
 * Both arguments are mandatory: the run clears the named sheet, so it must never be able to guess
 * one. Point it at a scratch tab. It applies the `live-smoke-*` manifests, reads them back through
 * `read --typed`, locates a row through `query --locate`, and prints wall-clock per step so a
 * regression in round-trip count shows up as seconds rather than as a passing test.
 *
 * `--with-structural` adds the `insertRowsAfter`/`setCells` manifests. They drive the Insert menu by
 * its English label, so they only pass on a document whose Sheets UI is English; the default run
 * covers the read/write/clear/locate path instead, which is language independent.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawCellValue } from '../src/typedValues.js'

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const [watcher, sheet] = positional
const withStructural = process.argv.includes('--with-structural')
if (!watcher || !sheet) {
	console.error('Usage: bun run smoke <watcher> <sheetName> [--with-structural]   (the sheet is cleared; use a scratch tab)')
	process.exit(2)
}

/** The 5x5 typed paste is the headline number: 30.7 s before the rectangle read, target under 8 s. */
const SET_RANGE_BUDGET_MS = 8_000
const MANIFEST_SHEET = '__ARGUS_SMOKE_20260806__'
const workDir = mkdtempSync(join(tmpdir(), 'argus-sheets-smoke-'))
const failures: string[] = []

const argus = (args: string[]): string => execFileSync('argus', args, { encoding: 'utf8' })

/** Run a command that is allowed to fail, so one broken step still lets the run finish and tidy up. */
const tryArgus = (args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } => {
	try {
		return { ok: true, stdout: argus(args) }
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? String(error)
		return { ok: false, stderr: stderr.trim().split('\n')[0] }
	}
}

const step = async <T>(label: string, run: () => Promise<T> | T, budgetMs?: number): Promise<T> => {
	const startedAt = Date.now()
	const value = await run()
	const elapsed = Date.now() - startedAt
	const over = budgetMs != null && elapsed > budgetMs
	if (over) failures.push(`${label} took ${elapsed} ms, over the ${budgetMs} ms budget`)
	console.log(`${over ? 'SLOW' : ' ok '}  ${String(elapsed).padStart(6)} ms  ${label}`)
	return value
}

const check = (label: string, condition: boolean, detail: string): void => {
	if (!condition) failures.push(`${label}: ${detail}`)
	console.log(`${condition ? ' ok ' : 'FAIL'}           ${label}${condition ? '' : ` — ${detail}`}`)
}

/** Retarget a `live-smoke-*` manifest at the sheet this run was pointed at. */
const manifestPath = async (name: string): Promise<string> => {
	const source = await Bun.file(new URL(`./fixtures/live-smoke-${name}.json`, import.meta.url)).text()
	const path = join(workDir, `${name}.json`)
	writeFileSync(path, source.replaceAll(MANIFEST_SHEET, sheet), 'utf8')
	return path
}

const apply = async (name: string): Promise<{ status: string; failure: string | null }> => {
	const path = await manifestPath(name)
	const result = tryArgus(['gs', 'apply', watcher, '--file', path, '--yes', '--json'])
	if (!result.ok) return { status: 'failed', failure: result.stderr }
	return { ...(JSON.parse(result.stdout) as { status: string }), failure: null }
}

const clearSheet = (): void => {
	argus(['gs', 'switch', watcher, sheet])
	argus(['gs', 'select', watcher, 'A1:Z100'])
	argus(['keydown', watcher, '--key', 'Delete'])
}

console.log(`Smoke: watcher ${watcher}, sheet ${JSON.stringify(sheet)} (cleared), work dir ${workDir}\n`)

await step('clear the sheet', clearSheet)
const seeded = await step('apply setRange 5x5 (preflight + recheck + verify)', () => apply('manifest'), SET_RANGE_BUDGET_MS)
check('setRange applied', seeded.status === 'complete', seeded.failure ?? `status was ${seeded.status}`)

const typed = await step(
	'read --typed A1:E5',
	() => JSON.parse(argus(['gs', 'read', watcher, '--sheet', sheet, '--range', 'A1:E5', '--typed', '--json'])) as { cells: RawCellValue[][] },
)
const cells = typed.cells
check('decimal stayed a number', cells[1][3].value === 1.5 && !cells[1][3].hasFormula, JSON.stringify(cells[1][3]))
check('boolean stayed a boolean', cells[1][2].value === true, JSON.stringify(cells[1][2]))
check(
	'blank row is blank',
	cells[2].every((cell) => cell.value === null && !cell.hasFormula),
	JSON.stringify(cells[2]),
)
check('formula source resolved to A1', cells[4][4].hasFormula && cells[4][4].formula === '=D5*2', JSON.stringify(cells[4][4]))
check('formula evaluated', cells[4][4].value === 7, JSON.stringify(cells[4][4].value))

const located = await step(
	'query --locate id=872',
	() =>
		JSON.parse(argus(['gs', 'query', watcher, '--sheet', sheet, '--where', 'id in [872]', '--locate', '--json'])) as {
			locator: { scannedRows: number; complete: boolean }
			rows: Array<{ location: { sheetRow: number } | null }>
		},
)
check('locator resolved the physical row', located.rows[0]?.location?.sheetRow === 5, JSON.stringify(located.rows[0]?.location))
check(
	'monotone locator stayed cheap',
	located.locator.complete && located.locator.scannedRows <= 2,
	`scannedRows ${located.locator.scannedRows}, complete ${located.locator.complete}`,
)

if (withStructural) {
	const inserted = await step('apply insertRowsAfter', () => apply('insert'))
	check('insertRowsAfter applied', inserted.status === 'complete', inserted.failure ?? `status was ${inserted.status}`)
	const sparse = await step('apply setCells', () => apply('sparse'))
	check('setCells applied', sparse.status === 'complete', sparse.failure ?? `status was ${sparse.status}`)
} else {
	console.log(' --   structural manifests skipped (pass --with-structural on an English Sheets UI)')
}

const cleared = await step('apply clear (one Delete, verified raw)', () => apply('clear'))
check('clear applied', cleared.status === 'complete', cleared.failure ?? `status was ${cleared.status}`)

await step('clear the sheet', clearSheet)

console.log()
if (failures.length === 0) {
	console.log('Smoke passed.')
	process.exit(0)
}
for (const failure of failures) console.log(`FAIL  ${failure}`)
process.exit(1)
