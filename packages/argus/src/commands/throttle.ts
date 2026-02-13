import type { ThrottleSetResponse, ThrottleClearResponse, ThrottleStatusResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export type ThrottleSetOptions = {
	json?: boolean
}

export const runThrottleSet = async (id: string | undefined, rateRaw: string, options: ThrottleSetOptions): Promise<void> => {
	const output = createOutput(options)

	const rate = Number(rateRaw)
	if (!Number.isFinite(rate) || rate < 1) {
		output.writeWarn('rate must be a number >= 1 (1 = no throttle, 4 = 4x slowdown)')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherJson<ThrottleSetResponse | ErrorResponse>({
		id,
		path: '/throttle',
		method: 'POST',
		body: { action: 'set', rate },
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
	if (res.applied) {
		output.writeHuman(`Applied CPU throttle: ${rate}x`)
	} else if (!res.attached) {
		output.writeHuman(`Queued CPU throttle (watcher detached): ${rate}x`)
	} else {
		output.writeHuman(`Throttle set but not applied: ${rate}x`)
		if (res.error) {
			output.writeWarn(`Error: ${res.error.message}`)
		}
	}
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export type ThrottleClearOptions = {
	json?: boolean
}

export const runThrottleClear = async (id: string | undefined, options: ThrottleClearOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<ThrottleClearResponse | ErrorResponse>({
		id,
		path: '/throttle',
		method: 'POST',
		body: { action: 'clear' },
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

	output.writeHuman('Cleared CPU throttle')
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
	lines.push(`cpu:      ${res.state ? `${res.state.rate}x slowdown` : 'none'}`)

	if (res.lastError) {
		lines.push(`error:    ${res.lastError.message}`)
	}

	output.writeHuman(lines.join('\n'))
}
