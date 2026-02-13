import type { ThrottleState, ThrottleSetResponse, ThrottleClearResponse, ThrottleStatusResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'
import { resolveNetworkPreset, listNetworkPresetNames } from '../throttle/networkPresets.js'

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export type ThrottleSetOptions = {
	cpu?: string
	network?: string
	latency?: string
	down?: string
	up?: string
	offline?: boolean
	cache?: boolean
	json?: boolean
}

export const runThrottleSet = async (id: string | undefined, options: ThrottleSetOptions): Promise<void> => {
	const output = createOutput(options)
	const state: ThrottleState = {}

	// CPU
	if (options.cpu != null) {
		const rate = Number(options.cpu)
		if (!Number.isFinite(rate) || rate < 1) {
			output.writeWarn('--cpu must be a number >= 1')
			process.exitCode = 2
			return
		}
		state.cpu = { rate }
	}

	// Network — preset or custom
	const hasCustomNetwork = options.latency != null || options.down != null || options.up != null || options.offline === true

	if (options.network && hasCustomNetwork) {
		output.writeWarn('Cannot combine --network preset with --latency/--down/--up/--offline')
		process.exitCode = 2
		return
	}

	if (options.network) {
		const preset = resolveNetworkPreset(options.network)
		if (!preset) {
			output.writeWarn(`Unknown network preset: ${options.network}`)
			output.writeWarn(`Available: ${listNetworkPresetNames().join(', ')}`)
			process.exitCode = 2
			return
		}
		state.network = preset
	} else if (hasCustomNetwork) {
		const latency = options.latency != null ? Number(options.latency) : 0
		const down = options.down != null ? Number(options.down) : -1
		const up = options.up != null ? Number(options.up) : -1

		if (!Number.isFinite(latency) || latency < 0) {
			output.writeWarn('--latency must be a number >= 0')
			process.exitCode = 2
			return
		}
		if (!Number.isFinite(down)) {
			output.writeWarn('--down must be a finite number')
			process.exitCode = 2
			return
		}
		if (!Number.isFinite(up)) {
			output.writeWarn('--up must be a finite number')
			process.exitCode = 2
			return
		}

		state.network = {
			offline: options.offline === true,
			latency,
			downloadThroughput: down,
			uploadThroughput: up,
		}
	}

	// Cache (--no-cache flag means cache.disabled = true)
	if (options.cache === false) {
		state.cache = { disabled: true }
	}

	if (!state.cpu && !state.network && !state.cache) {
		output.writeWarn('Specify at least one: --cpu, --network, --no-cache, or custom network flags')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherJson<ThrottleSetResponse | ErrorResponse>({
		id,
		path: '/throttle',
		method: 'POST',
		body: { action: 'set', state },
		timeoutMs: 10_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	const response = result.data
	if (!response.ok) {
		const err = response as ErrorResponse
		if (options.json) {
			output.writeJson(response)
		} else {
			output.writeWarn(`Error: ${err.error.message}`)
		}
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	const res = response as ThrottleSetResponse
	const label = formatThrottleLabel(state)

	if (res.applied) {
		output.writeHuman(`Applied throttle: ${label}`)
	} else if (!res.attached) {
		output.writeHuman(`Queued throttle (watcher detached): ${label}`)
	} else {
		output.writeHuman(`Throttle set but not applied: ${label}`)
		if (res.error) {
			output.writeWarn(`Error: ${res.error.message}`)
		}
	}
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export type ThrottleClearOptions = {
	cpu?: boolean
	network?: boolean
	cache?: boolean
	json?: boolean
}

export const runThrottleClear = async (id: string | undefined, options: ThrottleClearOptions): Promise<void> => {
	const output = createOutput(options)

	// Collect aspects to clear (if any specified, partial clear; otherwise full clear)
	const aspects: ('cpu' | 'network' | 'cache')[] = []
	if (options.cpu) aspects.push('cpu')
	if (options.network) aspects.push('network')
	if (options.cache) aspects.push('cache')

	const body: Record<string, unknown> = { action: 'clear' }
	if (aspects.length > 0) {
		body.aspects = aspects
	}

	const result = await requestWatcherJson<ThrottleClearResponse | ErrorResponse>({
		id,
		path: '/throttle',
		method: 'POST',
		body,
		timeoutMs: 10_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	const response = result.data
	if (!response.ok) {
		const err = response as ErrorResponse
		if (options.json) {
			output.writeJson(response)
		} else {
			output.writeWarn(`Error: ${err.error.message}`)
		}
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	if (aspects.length > 0) {
		output.writeHuman(`Cleared throttle: ${aspects.join(', ')}`)
	} else {
		output.writeHuman('Cleared all throttle settings')
	}
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export type ThrottleStatusOptions = {
	json?: boolean
}

export const runThrottleStatus = async (id: string | undefined, options: ThrottleStatusOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<ThrottleStatusResponse | ErrorResponse>({
		id,
		path: '/throttle',
		method: 'GET',
		timeoutMs: 5_000,
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	const response = result.data
	if (!response.ok) {
		const err = response as ErrorResponse
		if (options.json) {
			output.writeJson(response)
		} else {
			output.writeWarn(`Error: ${err.error.message}`)
		}
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	const res = response as ThrottleStatusResponse
	const lines: string[] = []
	lines.push(`attached: ${res.attached}`)
	lines.push(`applied:  ${res.applied}`)

	if (res.state?.cpu) {
		lines.push(`cpu:      ${res.state.cpu.rate}x slowdown`)
	} else {
		lines.push('cpu:      none')
	}

	if (res.state?.network) {
		const n = res.state.network
		if (n.offline) {
			lines.push('network:  offline')
		} else {
			lines.push(`network:  latency=${n.latency}ms down=${formatThroughput(n.downloadThroughput)} up=${formatThroughput(n.uploadThroughput)}`)
		}
	} else {
		lines.push('network:  none')
	}

	lines.push(`cache:    ${res.state?.cache?.disabled ? 'disabled' : 'enabled'}`)

	if (res.lastError) {
		lines.push(`error:    ${res.lastError.message}`)
	}

	output.writeHuman(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const formatThrottleLabel = (state: ThrottleState): string => {
	const parts: string[] = []
	if (state.cpu) parts.push(`cpu=${state.cpu.rate}x`)
	if (state.network) {
		if (state.network.offline) {
			parts.push('network=offline')
		} else {
			parts.push(
				`network(latency=${state.network.latency}ms down=${formatThroughput(state.network.downloadThroughput)} up=${formatThroughput(state.network.uploadThroughput)})`,
			)
		}
	}
	if (state.cache?.disabled) parts.push('cache=disabled')
	return parts.join(' ')
}

const formatThroughput = (bytesPerSec: number): string => {
	if (bytesPerSec < 0) return 'unlimited'
	if (bytesPerSec === 0) return '0'
	if (bytesPerSec >= 1_048_576) return `${(bytesPerSec / 1_048_576).toFixed(1)}MB/s`
	if (bytesPerSec >= 1_024) return `${(bytesPerSec / 1_024).toFixed(1)}KB/s`
	return `${bytesPerSec}B/s`
}
