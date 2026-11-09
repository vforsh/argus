import {
	NETWORK_THROTTLE_PRESET_NAMES,
	NETWORK_THROTTLE_PRESETS,
	type NetworkThrottleClearResponse,
	type NetworkThrottlePreset,
	type NetworkThrottleSetResponse,
	type NetworkThrottleState,
	type ThrottleClearResponse,
	type ThrottleSetResponse,
	type ThrottleStatusResponse,
} from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'

const TIMEOUT_WRITE_MS = 10_000
const TIMEOUT_READ_MS = 5_000

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export type ThrottleSetOptions = {
	json?: boolean
}

/** Execute `argus throttle set <id> <rate>`. */
export const runThrottleSet = defineWatcherCommand<ThrottleSetOptions, ThrottleSetResponse, unknown, [rateRaw: string], number>({
	build: ([rateRaw], _options, output) => {
		const rate = Number(rateRaw)
		if (!Number.isFinite(rate) || rate < 1) {
			output.writeWarn('rate must be a number >= 1 (1 = no throttle, 4 = 4x slowdown)')
			process.exitCode = 2
			return null
		}
		return { path: '/throttle', method: 'POST', body: { action: 'set', rate }, timeoutMs: TIMEOUT_WRITE_MS, meta: rate }
	},
	formatHuman: (response, { output, meta: rate }) => {
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

		// Watchers that predate network throttling report no `network` block.
		const network = response.network
		if (network) {
			const pending = network.state && !network.applied ? ' (not applied)' : ''
			lines.push(`network:  ${network.state ? formatNetworkConditions(network.state) : 'none'}${pending}`)
			if (network.lastError) {
				lines.push(`network error: ${network.lastError.message}`)
			}
		}

		output.writeHuman(lines.join('\n'))
	},
})

// ---------------------------------------------------------------------------
// net set
// ---------------------------------------------------------------------------

export type ThrottleNetSetOptions = {
	preset?: string
	latency?: string
	down?: string
	up?: string
	json?: boolean
}

/** Execute `argus throttle net set <id>`. */
export const runThrottleNetSet = defineWatcherCommand<ThrottleNetSetOptions, NetworkThrottleSetResponse, unknown, [], NetworkThrottleState>({
	build: (_args, options, output) => {
		const conditions = buildNetworkConditions(options, output)
		if (!conditions) {
			process.exitCode = 2
			return null
		}
		return { path: '/throttle/net', method: 'POST', body: { action: 'set', conditions }, timeoutMs: TIMEOUT_WRITE_MS, meta: conditions }
	},
	formatHuman: (response, { output, meta: conditions }) => {
		const label = formatNetworkConditions(conditions)
		if (response.applied) {
			output.writeHuman(`Applied network throttle: ${label}`)
			return
		}
		if (!response.attached) {
			output.writeHuman(`Queued network throttle (watcher detached): ${label}`)
			return
		}
		output.writeHuman(`Network throttle set but not applied: ${label}`)
		if (response.error) {
			output.writeWarn(`Error: ${response.error.message}`)
		}
	},
})

/** Resolve the desired conditions from `--preset` plus per-value overrides; warns and returns null on bad input. */
const buildNetworkConditions = (options: ThrottleNetSetOptions, output: Output): NetworkThrottleState | null => {
	const base = resolveNetworkPreset(options.preset, output)
	if (!base) {
		return null
	}

	const latencyMs = parseNetworkValue(options.latency, '--latency', { allowZero: true }, output)
	const downloadKbps = parseNetworkValue(options.down, '--down', { allowZero: false }, output)
	const uploadKbps = parseNetworkValue(options.up, '--up', { allowZero: false }, output)
	if (latencyMs === null || downloadKbps === null || uploadKbps === null) {
		return null
	}

	const overridden = latencyMs !== undefined || downloadKbps !== undefined || uploadKbps !== undefined
	if (!overridden) {
		if (!options.preset) {
			output.writeWarn(`Provide --preset <${NETWORK_THROTTLE_PRESET_NAMES.join('|')}> or at least one of --latency, --down, --up`)
			return null
		}
		return base
	}
	if (base.offline) {
		output.writeWarn('--preset offline fails every request; it cannot be combined with --latency, --down, or --up')
		return null
	}

	// Hand-tuned values no longer match the preset, so its name is dropped rather than left to mislead `throttle status`.
	const conditions: NetworkThrottleState = {
		offline: false,
		latencyMs: latencyMs ?? base.latencyMs,
		downloadKbps: downloadKbps ?? base.downloadKbps,
		uploadKbps: uploadKbps ?? base.uploadKbps,
	}
	if (conditions.latencyMs === 0 && conditions.downloadKbps === undefined && conditions.uploadKbps === undefined) {
		output.writeWarn('Nothing to throttle: --latency 0 with no --down or --up. Use `argus throttle net clear` to restore normal conditions.')
		return null
	}
	return conditions
}

const UNTHROTTLED: NetworkThrottleState = { offline: false, latencyMs: 0 }

const resolveNetworkPreset = (name: string | undefined, output: Output): NetworkThrottleState | null => {
	if (name === undefined) {
		return UNTHROTTLED
	}
	if (!isNetworkPreset(name)) {
		output.writeWarn(`Unknown preset: ${name}`)
		output.writeWarn(`Available: ${NETWORK_THROTTLE_PRESET_NAMES.join(', ')}`)
		return null
	}
	return NETWORK_THROTTLE_PRESETS[name]
}

const isNetworkPreset = (name: string): name is NetworkThrottlePreset => (NETWORK_THROTTLE_PRESET_NAMES as readonly string[]).includes(name)

/** `undefined` when the flag is absent, `null` (after warning) when its value is not a usable number. */
const parseNetworkValue = (raw: string | undefined, flag: string, { allowZero }: { allowZero: boolean }, output: Output): number | undefined | null => {
	if (raw === undefined) {
		return undefined
	}
	const value = Number(raw)
	const valid = raw.trim() !== '' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
	if (!valid) {
		output.writeWarn(`${flag} must be a number ${allowZero ? '>= 0' : '> 0'}`)
		return null
	}
	return value
}

const formatNetworkConditions = (state: NetworkThrottleState): string => {
	if (state.offline) {
		return 'offline'
	}
	const parts = [`${state.latencyMs}ms latency`, `${formatKbps(state.downloadKbps)} down`, `${formatKbps(state.uploadKbps)} up`]
	return state.preset ? `${state.preset} (${parts.join(', ')})` : parts.join(', ')
}

const formatKbps = (kbps: number | undefined): string => (kbps === undefined ? 'unlimited' : `${kbps} kbps`)

// ---------------------------------------------------------------------------
// net clear
// ---------------------------------------------------------------------------

export type ThrottleNetClearOptions = {
	json?: boolean
}

/** Execute `argus throttle net clear <id>`. */
export const runThrottleNetClear = defineWatcherCommand<ThrottleNetClearOptions, NetworkThrottleClearResponse>({
	build: () => ({ path: '/throttle/net', method: 'POST', body: { action: 'clear' }, timeoutMs: TIMEOUT_WRITE_MS }),
	formatHuman: (response, { output }) => {
		// The watcher forgets the throttle either way; a failed reset means Chrome may still be throttled.
		if (response.error) {
			output.writeHuman('Network throttle cleared in the watcher but not reset in Chrome')
			output.writeWarn(`Error: ${response.error.message}`)
			return
		}
		output.writeHuman('Cleared network throttle')
	},
})
