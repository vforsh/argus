import type { ThrottleClearResponse, ThrottleSetResponse, ThrottleStatusResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

const TIMEOUT_WRITE_MS = 10_000
const TIMEOUT_READ_MS = 5_000

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export type ThrottleSetOptions = {
	json?: boolean
}

/** Execute `argus throttle set <id> <rate>`. */
export const runThrottleSet = defineWatcherCommand<ThrottleSetOptions, ThrottleSetResponse, unknown, [rateRaw: string]>({
	build: ([rateRaw], _options, output) => {
		const rate = Number(rateRaw)
		if (!Number.isFinite(rate) || rate < 1) {
			output.writeWarn('rate must be a number >= 1 (1 = no throttle, 4 = 4x slowdown)')
			process.exitCode = 2
			return null
		}
		return { path: '/throttle', method: 'POST', body: { action: 'set', rate }, timeoutMs: TIMEOUT_WRITE_MS }
	},
	formatHuman: (response, { output, args }) => {
		const rate = Number(args[0])
		if (response.applied) {
			output.writeHuman(`Applied CPU throttle: ${rate}x`)
			return
		}
		if (!response.attached) {
			output.writeHuman(`Queued CPU throttle (watcher detached): ${rate}x`)
			return
		}
		output.writeHuman(`Throttle set but not applied: ${rate}x`)
		if (response.error) {
			output.writeWarn(`Error: ${response.error.message}`)
		}
	},
})

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export type ThrottleClearOptions = {
	json?: boolean
}

/** Execute `argus throttle clear <id>`. */
export const runThrottleClear = defineWatcherCommand<ThrottleClearOptions, ThrottleClearResponse>({
	build: () => ({ path: '/throttle', method: 'POST', body: { action: 'clear' }, timeoutMs: TIMEOUT_WRITE_MS }),
	formatHuman: (_response, { output }) => {
		output.writeHuman('Cleared CPU throttle')
	},
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export type ThrottleStatusOptions = {
	json?: boolean
}

/** Execute `argus throttle status <id>`. */
export const runThrottleStatus = defineWatcherCommand<ThrottleStatusOptions, ThrottleStatusResponse>({
	build: () => ({ path: '/throttle', method: 'GET', timeoutMs: TIMEOUT_READ_MS }),
	formatHuman: (response, { output }) => {
		const lines: string[] = []
		lines.push(`attached: ${response.attached}`)
		lines.push(`applied:  ${response.applied}`)
		lines.push(`cpu:      ${response.state ? `${response.state.rate}x slowdown` : 'none'}`)

		if (response.lastError) {
			lines.push(`error:    ${response.lastError.message}`)
		}

		output.writeHuman(lines.join('\n'))
	},
})
