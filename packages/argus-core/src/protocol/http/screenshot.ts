/** Request payload for POST /screenshot. */
export type ScreenshotRequest = {
	outFile?: string
	selector?: string
	format?: 'png'
}

/** Response payload for POST /screenshot. */
export type ScreenshotResponse = {
	ok: true
	outFile: string
	clipped: boolean
}
