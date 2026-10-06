import type { EmulationViewport } from '@vforsh/argus-core'

/** Startup viewport flags; omitted dimensions use the headless baseline when any override is requested. */
export type StartViewportOptions = {
	headless?: boolean
	width?: string
	height?: string
	dpr?: string
}

/** Resolve CSS viewport metrics, or throw before launching Chrome when a flag is invalid. */
export const resolveStartViewport = (options: StartViewportOptions): EmulationViewport | undefined => {
	if (!options.headless && options.width === undefined && options.height === undefined && options.dpr === undefined) return undefined

	return {
		width: parseMetric(options.width, 1280, '--width', true),
		height: parseMetric(options.height, 900, '--height', true),
		deviceScaleFactor: parseMetric(options.dpr, 1, '--dpr', false),
		mobile: false,
	}
}

const parseMetric = (value: string | undefined, fallback: number, flag: string, integer: boolean): number => {
	if (value === undefined) return fallback
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
		throw new Error(`${flag} must be a positive ${integer ? 'integer' : 'number'}.`)
	}
	return parsed
}
