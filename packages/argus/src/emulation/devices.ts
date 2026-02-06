import type { EmulationViewport } from '@vforsh/argus-core'

/** A named device preset with emulation parameters. */
export type DevicePreset = {
	name: string
	viewport: EmulationViewport
	touch: boolean
	userAgent: string | null
}

/* eslint-disable */
const IPHONE_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
/* eslint-enable */

/** Curated device presets for emulation. */
export const DEVICE_PRESETS: DevicePreset[] = [
	{
		name: 'iphone-14',
		viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
		touch: true,
		userAgent: IPHONE_UA,
	},
	{
		name: 'iphone-15-pro-max',
		viewport: { width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
		touch: true,
		userAgent: IPHONE_UA,
	},
	{
		name: 'pixel-7',
		viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true },
		touch: true,
		userAgent: ANDROID_UA,
	},
	{
		name: 'ipad-mini',
		viewport: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
		touch: true,
		userAgent: IPAD_UA,
	},
	{
		name: 'desktop-1440',
		viewport: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
		touch: false,
		userAgent: null,
	},
	{
		name: 'desktop-1600',
		viewport: { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false },
		touch: false,
		userAgent: null,
	},
]

/** Resolve a device preset by name (case-insensitive). Returns null if not found. */
export const resolvePreset = (name: string): DevicePreset | null => {
	const lower = name.toLowerCase()
	return DEVICE_PRESETS.find((d) => d.name === lower) ?? null
}

/** List all available preset names. */
export const listPresetNames = (): string[] => {
	return DEVICE_PRESETS.map((d) => d.name)
}
