import type { EmulationState, EmulationSetResponse, EmulationClearResponse, EmulationStatusResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'
import { resolvePreset, listPresetNames } from '../emulation/devices.js'

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export type PageEmulationSetOptions = {
	device?: string
	width?: string
	height?: string
	dpr?: string
	mobile?: boolean
	touch?: boolean
	ua?: string
	json?: boolean
}

export const runPageEmulationSet = async (id: string | undefined, options: PageEmulationSetOptions): Promise<void> => {
	const output = createOutput(options)

	// Resolve base from preset (if any)
	let base: { viewport: EmulationState['viewport']; touch: boolean; userAgent: string | null } | null = null

	if (options.device) {
		const preset = resolvePreset(options.device)
		if (!preset) {
			output.writeWarn(`Unknown device: ${options.device}`)
			output.writeWarn(`Available: ${listPresetNames().join(', ')}`)
			process.exitCode = 2
			return
		}
		base = { viewport: preset.viewport, touch: preset.touch, userAgent: preset.userAgent }
	}

	// Parse numeric overrides
	const widthRaw = options.width != null ? Number(options.width) : null
	const heightRaw = options.height != null ? Number(options.height) : null
	const dprRaw = options.dpr != null ? Number(options.dpr) : null

	if (widthRaw != null && (!Number.isInteger(widthRaw) || widthRaw <= 0)) {
		output.writeWarn('--width must be a positive integer')
		process.exitCode = 2
		return
	}
	if (heightRaw != null && (!Number.isInteger(heightRaw) || heightRaw <= 0)) {
		output.writeWarn('--height must be a positive integer')
		process.exitCode = 2
		return
	}
	if (dprRaw != null && (!Number.isFinite(dprRaw) || dprRaw <= 0)) {
		output.writeWarn('--dpr must be a positive number')
		process.exitCode = 2
		return
	}

	// If width or height given without the other and no preset → error
	const hasWidth = widthRaw != null
	const hasHeight = heightRaw != null
	if ((hasWidth || hasHeight) && !base) {
		if (!hasWidth || !hasHeight) {
			output.writeWarn('Both --width and --height are required when not using --device')
			process.exitCode = 2
			return
		}
	}

	// If no preset and no viewport override → error
	if (!base && !hasWidth) {
		output.writeWarn('Provide --device or --width + --height')
		output.writeWarn(`Available devices: ${listPresetNames().join(', ')}`)
		process.exitCode = 2
		return
	}

	// Build viewport
	const baseViewport = base?.viewport ?? null
	const width = widthRaw ?? baseViewport?.width ?? 0
	const height = heightRaw ?? baseViewport?.height ?? 0
	const dpr = dprRaw ?? baseViewport?.deviceScaleFactor ?? 1
	const mobile = options.mobile ?? baseViewport?.mobile ?? false

	const viewport = { width, height, deviceScaleFactor: dpr, mobile }

	// Touch
	const touchEnabled = options.touch ?? base?.touch ?? false

	// User-agent
	const uaValue = options.ua !== undefined ? options.ua : (base?.userAgent ?? null)

	const state: EmulationState = {
		viewport,
		touch: { enabled: touchEnabled },
		userAgent: { value: uaValue },
	}

	const result = await requestWatcherJson<EmulationSetResponse | ErrorResponse>({
		id,
		path: '/emulation',
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

	const res = response as EmulationSetResponse
	const label = formatViewportLabel(viewport, touchEnabled, uaValue)

	if (res.applied) {
		output.writeHuman(`Applied emulation: ${label}`)
	} else if (!res.attached) {
		output.writeHuman(`Queued emulation (watcher detached): ${label}`)
	} else {
		output.writeHuman(`Emulation set but not applied: ${label}`)
		if (res.error) {
			output.writeWarn(`Error: ${res.error.message}`)
		}
	}
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export type PageEmulationClearOptions = {
	json?: boolean
}

export const runPageEmulationClear = async (id: string | undefined, options: PageEmulationClearOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<EmulationClearResponse | ErrorResponse>({
		id,
		path: '/emulation',
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

	output.writeHuman('Cleared emulation')
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export type PageEmulationStatusOptions = {
	json?: boolean
}

export const runPageEmulationStatus = async (id: string | undefined, options: PageEmulationStatusOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherJson<EmulationStatusResponse | ErrorResponse>({
		id,
		path: '/emulation',
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

	const res = response as EmulationStatusResponse
	const lines: string[] = []
	lines.push(`attached: ${res.attached}`)
	lines.push(`applied:  ${res.applied}`)

	if (res.state?.viewport) {
		const vp = res.state.viewport
		lines.push(`viewport: ${vp.width}x${vp.height}@${vp.deviceScaleFactor} ${vp.mobile ? 'mobile' : 'desktop'}`)
	} else {
		lines.push('viewport: none')
	}

	lines.push(`touch:    ${res.state?.touch?.enabled ? 'enabled' : 'disabled'}`)

	if (res.state?.userAgent?.value) {
		const ua = res.state.userAgent.value
		lines.push(`ua:       ${ua.length > 80 ? ua.slice(0, 77) + '...' : ua}`)
	} else {
		lines.push('ua:       default')
	}

	if (res.baseline.userAgent) {
		const bua = res.baseline.userAgent
		lines.push(`baseline: ${bua.length > 80 ? bua.slice(0, 77) + '...' : bua}`)
	}

	if (res.lastError) {
		lines.push(`error:    ${res.lastError.message}`)
	}

	output.writeHuman(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const formatViewportLabel = (
	viewport: { width: number; height: number; deviceScaleFactor: number; mobile: boolean },
	touch: boolean,
	ua: string | null,
): string => {
	const parts: string[] = [`${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`]
	if (viewport.mobile) parts.push('mobile')
	if (touch) parts.push('touch')
	if (ua) parts.push('ua=overridden')
	return parts.join(' ')
}
