import type { ScreenshotClipRegion } from './screenshot.js'

/** Viewport-relative crop rectangle in CSS pixels. */
export type RecordClipRegion = ScreenshotClipRegion

/** Supported recording containers/codecs. */
export const RECORD_FORMATS = ['mp4', 'webm'] as const

/** Recording container/codec preset. */
export type RecordFormat = (typeof RECORD_FORMATS)[number]

/** Shared options for video recording requests. */
export type RecordOptions = {
	outFile?: string
	selector?: string
	/** Viewport-relative crop rectangle in CSS pixels. Mutually exclusive with `selector`. */
	clip?: RecordClipRegion
	/** Output frames per second. Defaults to 30. */
	fps?: number
	/** Output format. Defaults to mp4 unless inferred from outFile extension. */
	format?: RecordFormat
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
	format: RecordFormat
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
	format: RecordFormat
	frameCount: number
	durationMs: number
	fps: number
	clipped: boolean
}

export type RecordResponse = RecordStopResponse
