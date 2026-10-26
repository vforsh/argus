import type { ReloadRequest, ReloadResponse } from '@vforsh/argus-core'
import { DEFAULT_RELOAD_TIMEOUT_MS } from '@vforsh/argus-core'
import { defineActionCommand } from '../cli/defineWatcherCommand.js'
import { parseDurationFlagMs } from './evalShared.js'

/** Options for the reload command. */
export type ReloadOptions = {
	json?: boolean
	ignoreCache?: boolean
	timeout?: string
}

/**
 * Transport headroom over the watcher's own reload deadline, so its answer — including the layered
 * stall diagnosis it runs after a CDP timeout (two short probes) — arrives before the HTTP request
 * gives up. Same reasoning as eval's grace in `eval/evalClient.ts`.
 */
const RELOAD_TRANSPORT_GRACE_MS = 8_000

/**
 * Execute the reload command for a watcher id.
 *
 * `--timeout` bounds the reload request only. `--until`/`--until-timeout` start after it returns,
 * so the two budgets add up rather than overlap.
 */
export const runReload = defineActionCommand<ReloadOptions, ReloadResponse, ReloadRequest>({
	build: (_args, options, output) => {
		const timeout = parseDurationFlagMs(options.timeout, '--timeout')
		if (timeout.error) {
			output.writeWarn(timeout.error)
			process.exitCode = 2
			return null
		}
		return reloadRequestPlan(options.ignoreCache ?? false, timeout.value)
	},
	formatHuman: (_response, { output, watcher }) => {
		output.writeHuman(`reloaded ${watcher.id}`)
	},
})

/** The `/reload` request with the watcher's deadline and the transport headroom over it; shared with `net watch --reload`. */
export const reloadRequestPlan = (ignoreCache: boolean, timeoutMs = DEFAULT_RELOAD_TIMEOUT_MS) => ({
	path: '/reload',
	method: 'POST' as const,
	body: { ignoreCache, timeoutMs } satisfies ReloadRequest,
	timeoutMs: timeoutMs + RELOAD_TRANSPORT_GRACE_MS,
})
