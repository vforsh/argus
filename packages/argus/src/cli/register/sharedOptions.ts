import type { ArgusCommandOption } from '../defineCommand.js'

/**
 * The `--json` flag, declared once.
 *
 * Sixty-four command definitions spelled out this same object literal, and two register files had
 * already invented private copies of it. Commands whose JSON output makes a different promise
 * ("newline-delimited requests", "bounded preview") still write their own description; the point is
 * that the plain case has exactly one spelling.
 */
export const jsonOption: ArgusCommandOption = { flags: '--json', description: 'Output JSON for automation' }

/**
 * Post-action flags for page actions built with `defineActionCommand`.
 *
 * `--until` replaces the `click …; sleep 3; eval …` pattern agents fall back to: the action
 * reports only once the page reached the state the caller cares about.
 */
export const actionOptions: readonly ArgusCommandOption[] = [
	{ flags: '--until <expr>', description: 'After the action, poll this page expression until truthy (throws count as not yet)' },
	{ flags: '--until-timeout <duration>', description: 'Budget for --until (e.g. 30s). Default: 15s' },
	{ flags: '-q, --quiet', description: 'Print nothing on success; errors still print' },
]

/**
 * `--fields` / `--max-chars` output shaping for `eval`, `logs`, and `net`.
 *
 * Parsed and applied by `output/projection.ts`; declared here so manifests don't load the runtime helper.
 */
export const outputShapingOptions: readonly ArgusCommandOption[] = [
	{ flags: '--fields <paths>', description: 'Keep only these comma-separated dot paths of each record (e.g. id,url,status or user.name)' },
	{ flags: '--max-chars <n>', description: 'Cap output at N characters; truncation is marked explicitly and JSON stays valid' },
]
