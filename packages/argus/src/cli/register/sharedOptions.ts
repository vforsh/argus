import type { ArgusCommandOption } from '../defineCommand.js'
import { collectValues } from '../validation.js'

/**
 * The `--json` flag, declared once.
 *
 * Sixty-four command definitions spelled out this same object literal, and two register files had
 * already invented private copies of it. Commands whose JSON output makes a different promise
 * ("newline-delimited requests", "bounded preview") still write their own description; the point is
 * that the plain case has exactly one spelling.
 */
export const jsonOption: ArgusCommandOption = { flags: '--json', description: 'Output JSON for automation' }

/** `--label key=value` as a filter on `list`, `watcher stop` and `watcher prune`. */
export const labelFilterOption: ArgusCommandOption = {
	flags: '--label <key=value>',
	description: 'Only watchers carrying this label (repeatable; all must match)',
	parser: collectValues,
	defaultValue: [],
}

/** Self-stop and tagging flags shared by `start` and `watcher start`. */
export const watcherLifecycleOptions: readonly ArgusCommandOption[] = [
	{ flags: '--owner-pid <pid>', description: 'Stop (and close a Chrome this command launched) once this process exits, even after SIGKILL' },
	{ flags: '--idle-exit <duration>', description: 'Stop after this long with no CLI request against the watcher (e.g. 15m); list/status pings do not count' },
	{ flags: '--ttl <duration>', description: 'Stop this long after start, regardless of activity (e.g. 2h)' },
	{ flags: '--label <key=value>', description: 'Tag the watcher (repeatable); filter with list/stop/prune --label', parser: collectValues, defaultValue: [] },
]

/**
 * Post-action flags for page actions built with `defineActionCommand`.
 *
 * `--until` and `--settle` replace the `click …; sleep 3; eval …` pattern agents fall back to: the
 * action reports only once the page reached the state the caller cares about (`--until`) or
 * stopped moving (`--settle`).
 */
export const actionOptions: readonly ArgusCommandOption[] = [
	{ flags: '--until <expr>', description: 'After the action, poll this page expression until truthy (throws count as not yet)' },
	{ flags: '--until-timeout <duration>', description: 'Budget for --until (e.g. 30s). Default: 15s' },
	{ flags: '--settle', description: 'After the action, wait for load, a quiet network, and window.__argus.settle() (default for navigations)' },
	{ flags: '--no-settle', description: 'Skip the settle wait (navigations settle by default)' },
	{ flags: '--settle-timeout <duration>', description: 'Budget for --settle (e.g. 5s). Default: 10s; a miss warns and continues' },
	{ flags: '-q, --quiet', description: 'Print nothing on success; errors still print' },
]

/**
 * Pre-read wait flags for read commands (`probe`, `eval`, `dom info/tree`, `screenshot`, `snapshot`, `logs`, `net`).
 *
 * The mirror of {@link actionOptions}: an action waits after itself, a read waits before itself, so
 * `reload --settle` followed by `probe --until …` needs no `sleep` in between. See `commands/preReadWait.ts`.
 */
export const readWaitOptions: readonly ArgusCommandOption[] = [
	{ flags: '--until <expr>', description: 'Before reading, poll this page expression until truthy (throws count as not yet); a miss exits 1' },
	{ flags: '--until-timeout <duration>', description: 'Budget for --until (e.g. 30s). Default: 15s' },
	{ flags: '--settle', description: 'Before reading, wait for load, a quiet network, and window.__argus.settle()' },
	{ flags: '--settle-timeout <duration>', description: 'Budget for --settle (e.g. 5s). Default: 10s; a miss warns and reads anyway' },
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
