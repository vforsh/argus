import type { ArgusPluginContextV1 } from '@vforsh/argus-plugin-api'
import { buildSwitchSheetExpression } from './pageScripts.js'
import { evalInWatcher, type Output, withSheetLease } from './sheetCommandUtils.js'
import type { SheetListResult, SheetSwitchResult } from './sheetTabsTypes.js'

/** Resolve all visible gids through short stepped evals with guard, progress, deadline, lease, and restoration. */
export const collectGidsStepped = async (
	ctx: ArgusPluginContextV1,
	id: string | undefined,
	output: Output,
	base: SheetListResult,
	options: { force?: boolean },
	deadlineMs: number,
): Promise<SheetListResult | null> => {
	if (base.sheets.length > 100 && !options.force) {
		output.writeWarn(
			`Refusing to activate ${base.sheets.length} sheets (guard: 100). Resolve a known name directly, or add --force with --deadline.`,
		)
		process.exitCode = 2
		return null
	}
	output.writeWarn(`Resolving ${base.sheets.length} sheet gids with a ${deadlineMs}ms internal deadline; original sheet will be restored.`)
	const deadlineAt = Date.now() + deadlineMs
	const leased = await withSheetLease(
		ctx,
		id,
		output,
		{ operation: 'resolve all sheet gids', restore: true, ttlMs: deadlineMs + 10_000 },
		async () => {
			const sheets: SheetListResult['sheets'] = []
			for (let index = 0; index < base.sheets.length; index++) {
				if (Date.now() >= deadlineAt) return { sheets, complete: false }
				const tab = base.sheets[index]
				if (tab.gid) sheets.push(tab)
				else {
					const switched = await evalInWatcher<SheetSwitchResult>(ctx, id, buildSwitchSheetExpression(tab.name), output, {
						evalTimeoutMs: 5_000,
						requestTimeoutMs: 8_000,
					})
					if (!switched) return null
					sheets.push({ ...switched.sheet, active: switched.sheet.gid === base.activeGid })
				}
				if ((index + 1) % 25 === 0 || index + 1 === base.sheets.length)
					output.writeWarn(`Resolved ${index + 1}/${base.sheets.length} sheet gids.`)
			}
			return { sheets, complete: true }
		},
	)
	const traversal = leased?.value
	if (!traversal) return null
	if (!traversal.complete) {
		output.writeWarn(
			`Sheet gid traversal deadline reached after ${traversal.sheets.length}/${base.sheets.length}; no browser promise continues switching tabs.`,
		)
		process.exitCode = 1
	}
	const resolved = new Map(traversal.sheets.map((sheet) => [sheet.index, sheet]))
	return { ...base, sheets: base.sheets.map((sheet) => resolved.get(sheet.index) ?? sheet) }
}
