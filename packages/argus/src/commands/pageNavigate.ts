import type {
	NavigateHistoryRequest,
	NavigateHistoryResponse,
	NavigateRequest,
	NavigateResponse,
	NavigationDirection,
	NavigationWait,
} from '@vforsh/argus-core'
import { DEFAULT_NAVIGATION_TIMEOUT_MS, DEFAULT_NAVIGATION_WAIT, NAVIGATION_WAITS } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import { parseDurationFlagMs } from './evalShared.js'
import type { Output } from '../output/io.js'

/** Flags shared by `goto`, `back`, and `forward`. */
type NavigationFlags = {
	wait?: string
	timeout?: string
	json?: boolean
}

/** Options for `argus page goto` / `argus goto`. */
export type PageGotoOptions = NavigationFlags & {
	param?: string[]
	params?: string
}

/** Options for `argus page back` / `argus page forward`. */
export type PageHistoryOptions = NavigationFlags & {
	steps?: string
}

/**
 * Validate `--wait` and `--timeout` once for every navigation command.
 *
 * The watcher's own budget is the wait timeout; the HTTP request gets 5s more so a wait that
 * legitimately runs to its limit reports `navigation_timeout` instead of being cut off in
 * transport, which would say nothing useful about the page.
 */
const parseNavigationFlags = (options: NavigationFlags, output: Output): { wait: NavigationWait; timeoutMs: number } | null => {
	const wait = options.wait ?? DEFAULT_NAVIGATION_WAIT
	if (!isNavigationWait(wait)) {
		output.writeWarn(`Invalid --wait value: expected one of ${NAVIGATION_WAITS.join(', ')}.`)
		process.exitCode = 2
		return null
	}

	const timeout = parseDurationFlagMs(options.timeout, '--timeout')
	if (timeout.error) {
		output.writeWarn(timeout.error)
		process.exitCode = 2
		return null
	}

	return { wait, timeoutMs: timeout.value ?? DEFAULT_NAVIGATION_TIMEOUT_MS }
}

const isNavigationWait = (value: string): value is NavigationWait => (NAVIGATION_WAITS as readonly string[]).includes(value)

/** Wrap a navigation request plan with the transport headroom described above. */
const navigationPlan = (path: string, body: unknown, timeoutMs: number): WatcherRequestPlan => ({
	path,
	method: 'POST',
	body,
	timeoutMs: timeoutMs + 5_000,
})

/** `argus page goto [id] <url>` (also `argus goto`) — navigate the attached page. */
export const runPageGoto = defineWatcherCommand<PageGotoOptions, NavigateResponse, NavigateRequest, [url: string | undefined]>({
	build: ([url], options, output) => {
		const trimmedUrl = url?.trim()
		const hasParam = (options.param?.length ?? 0) > 0
		if (!trimmedUrl && !hasParam && options.params == null) {
			output.writeWarn('A <url> is required (or --param/--params to rewrite the current URL).')
			process.exitCode = 2
			return null
		}

		const flags = parseNavigationFlags(options, output)
		if (!flags) return null

		const body: NavigateRequest = { wait: flags.wait, timeoutMs: flags.timeoutMs }
		if (trimmedUrl) body.url = trimmedUrl
		if (hasParam) body.param = options.param
		if (options.params != null) body.params = options.params

		return navigationPlan('/navigate', body, flags.timeoutMs)
	},
	formatHuman: (response, { output, watcher }) => {
		output.writeHuman(`navigated ${watcher.id} → ${response.url} (${response.waited}, epoch ${response.epoch})`)
	},
})

/** Internal runner behind `back` and `forward`; the direction rides as a positional arg. */
const historyRunner = defineWatcherCommand<PageHistoryOptions, NavigateHistoryResponse, NavigateHistoryRequest, [NavigationDirection]>({
	build: ([direction], options, output) => {
		const steps = options.steps == null ? 1 : Number(options.steps)
		if (!Number.isInteger(steps) || steps < 1) {
			output.writeWarn('Invalid --steps value: expected a positive integer.')
			process.exitCode = 2
			return null
		}

		const flags = parseNavigationFlags(options, output)
		if (!flags) return null

		const body: NavigateHistoryRequest = { direction, steps, wait: flags.wait, timeoutMs: flags.timeoutMs }
		return navigationPlan('/navigate/history', body, flags.timeoutMs)
	},
	formatHuman: (response, { output, watcher, args: [direction] }) => {
		output.writeHuman(`${direction} ${watcher.id} → ${response.url} [${response.index + 1}/${response.length}]`)
	},
})

/** `argus page back [id]` — move one (or `--steps n`) entry back in session history. */
export const runPageBack = (id: string | undefined, options: PageHistoryOptions): Promise<void> => historyRunner(id, 'back', options)

/** `argus page forward [id]` — move one (or `--steps n`) entry forward in session history. */
export const runPageForward = (id: string | undefined, options: PageHistoryOptions): Promise<void> => historyRunner(id, 'forward', options)
