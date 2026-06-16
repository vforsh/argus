import type { ScreenshotClipRegion } from './screenshot.js'

/** Viewport-relative crop rectangle in CSS pixels. */
export type RecordClipRegion = ScreenshotClipRegion

/** Shared options for WebM recording requests. */
export type RecordOptions = {
	outFile?: string
	selector?: string
	/** Viewport-relative crop rectangle in CSS pixels. Mutually exclusive with `selector`. */
	clip?: RecordClipRegion
	/** Output frames per second. Defaults to 30. */
	fps?: number
	format?: 'webm'
}

/** Request payload for POST /record. */
export type RecordRequest = RecordOptions & {
	/** Capture duration in milliseconds. */
	durationMs: number
}

/** Request payload for POST /record/start. */
export type RecordStartRequest = RecordOptions

/** Response payload for POST /record/start. */
export type RecordStartResponse = {
	ok: true
	recordId: string
	sessionName: string
	outFile: string
	fps: number
	clipped: boolean
}

/** Request payload for POST /record/stop. */
export type RecordStopRequest = {
	recordId?: string
	outFile?: string
}

/** Response payload for POST /record and POST /record/stop. */
export type RecordStopResponse = {
	ok: true
	recordId: string
	sessionName: string
	outFile: string
	frameCount: number
	durationMs: number
	fps: number
	clipped: boolean
}

export type RecordResponse = RecordStopResponse
