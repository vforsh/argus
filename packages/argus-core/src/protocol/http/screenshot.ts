/** Rectangle crop in CSS pixels relative to the selected target viewport. */
export type ScreenshotClipRegion = {
	x: number
	y: number
	width: number
	height: number
}

/** Request payload for POST /screenshot. */
export type ScreenshotRequest = {
	outFile?: string
	selector?: string
	/** Viewport-relative crop rectangle in CSS pixels. Mutually exclusive with `selector`. */
	clip?: ScreenshotClipRegion
	format?: 'png'
}

/** Response payload for POST /screenshot. */
export type ScreenshotResponse = {
	ok: true
	outFile: string
	clipped: boolean
}
