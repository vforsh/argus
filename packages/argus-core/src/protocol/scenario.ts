/**
 * Host-bridge types for bundled eval scenarios.
 *
 * These describe the in-page capability object handed to a scenario's `export default`,
 * not an HTTP payload — the members are functions returning promises and are never
 * serialized over the wire. They live outside `protocol/http/` for exactly that reason.
 */
import type { LogEpoch, LogEvent, LogLevel } from './logs.js'
import type { ScreenshotClipRegion, ScreenshotResponse } from './http/screenshot.js'

/** Page-side screenshot options accepted by scenario artifact helpers. */
export type ArgusScenarioScreenshotOptions = {
	/** Crop to the first matching element. */
	selector?: string
	/** Crop to a viewport-relative rectangle. Mutually exclusive with `selector`. */
	clip?: ScreenshotClipRegion
}

/** Filters for reading watcher logs from a scenario cursor. */
export type ArgusScenarioLogOptions = {
	/** Only include these severity levels. */
	levels?: LogLevel[]
	/** Match event text against any supplied regular expression. */
	match?: string | string[]
	/** Regex case handling. Defaults to case-sensitive. */
	matchCase?: 'sensitive' | 'insensitive'
	/** Case-insensitive substring filter over the event source. */
	source?: string
	/** Maximum number of matching events. Defaults to 500; maximum 5000. */
	limit?: number
}

/** Result of reading scenario logs after a cursor. */
export type ArgusScenarioLogsResult = {
	events: LogEvent[]
	/** Cursor to use for the next read. */
	nextCursor: LogEpoch
}

/** Stateful log window created at a scenario-defined baseline. */
export type ArgusScenarioLogSession = {
	/** Current session cursor. It advances after each successful read. */
	readonly cursor: LogEpoch
	/** Read matching logs since the session cursor and advance it. */
	read: (options?: ArgusScenarioLogOptions) => Promise<ArgusScenarioLogsResult>
}

/** Log cursor helpers available to bundled scenario entrypoints. */
export type ArgusScenarioLogs = {
	/** Return the watcher's current log cursor without downloading events. */
	cursor: () => Promise<LogEpoch>
	/** Read matching logs produced strictly after `cursor`. */
	read: (cursor: LogEpoch, options?: ArgusScenarioLogOptions) => Promise<ArgusScenarioLogsResult>
	/** Capture the current cursor and return a stateful log window. */
	session: () => Promise<ArgusScenarioLogSession>
}

/** Host capabilities passed to `export default` in a bundled eval file. */
export type ArgusScenarioContext = {
	/** Frozen string arguments supplied by `--arg` / `--args`. */
	readonly args: Readonly<Record<string, string>>
	/** Capture a screenshot using a watcher-generated safe artifact path. */
	screenshot: (options?: ArgusScenarioScreenshotOptions) => Promise<ScreenshotResponse>
	/** Capture or replace `checkpoints/<name>.png` under the watcher artifact directory. */
	checkpoint: (name: string, options?: ArgusScenarioScreenshotOptions) => Promise<ScreenshotResponse>
	/** Cursor and session helpers for logs produced during the scenario. */
	readonly logs: ArgusScenarioLogs
}
