import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalEnum, optionalNonEmptyString, optionalNumber, optionalString, readFields, requireObject } from '../schemaFields.js'
import { optionalClipRegion, requireSingleCaptureTarget } from './screenshot.js'

import type { ScreenshotClipRegion } from './screenshot.js'
import type { Ok } from './errors.js'

/** Viewport-relative crop rectangle in CSS pixels. */
export type RecordClipRegion = ScreenshotClipRegion

/** Supported recording containers/codecs. */
export const RECORD_FORMATS = ['mp4', 'webm'] as const

/** Recording container/codec preset. */
export type RecordFormat = (typeof RECORD_FORMATS)[number]

/** Shared options for video recording requests. */
export type RecordOptions = {
	/**
	 * Where the watcher writes the artifact.
	 *
	 * An absolute path is used verbatim. A relative path resolves under the *watcher's* artifacts
	 * directory (a temp dir), never the caller's cwd — the watcher is a separate process. Callers
	 * that mean "next to me" must resolve the path before sending it; the CLI does.
	 */
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
export type RecordStartResponse = Ok<{
	recordId: string
	sessionName: string
	outFile: string
	format: RecordFormat
	fps: number
	clipped: boolean
}>

/** Request payload for POST /record/stop. */
export type RecordStopRequest = {
	recordId?: string
	/** Final path for the saved recording. Same resolution rules as {@link RecordOptions.outFile}. */
	outFile?: string
}

/** Response payload for POST /record and POST /record/stop. */
export type RecordStopResponse = Ok<{
	recordId: string
	sessionName: string
	outFile: string
	format: RecordFormat
	frameCount: number
	durationMs: number
	fps: number
	clipped: boolean
}>

export type RecordResponse = RecordStopResponse

/** Readers for the outFile/selector/clip/fps/format options every record route shares. */
const recordOptionReaders = {
	outFile: optionalString,
	selector: optionalNonEmptyString,
	clip: optionalClipRegion,
	fps: (source: Record<string, unknown>, key: string) => optionalNumber(source, key, { min: 1, max: 60 }),
	format: (source: Record<string, unknown>, key: string) => optionalEnum(source, key, RECORD_FORMATS),
}

/** Schema for POST /record/start request payloads. */
export const recordStartRequestSchema = defineProtocolSchema<RecordStartRequest>((value) => {
	const invalid = requireObject<RecordStartRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, recordOptionReaders)
	if (!fields.ok) return fields

	const conflict = requireSingleCaptureTarget(fields.value)
	if (conflict) return invalidProtocolPayload(conflict)

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /record request payloads (fixed-duration capture). */
export const recordRequestSchema = defineProtocolSchema<RecordRequest>((value) => {
	const invalid = requireObject<RecordRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		...recordOptionReaders,
		durationMs: (source, key) => optionalNumber(source, key, { min: Number.EPSILON }),
	})
	if (!fields.ok) return fields

	const conflict = requireSingleCaptureTarget(fields.value)
	if (conflict) return invalidProtocolPayload(conflict)

	if (fields.value.durationMs == null) {
		return invalidProtocolPayload('durationMs must be greater than 0')
	}

	return validProtocolPayload(compact({ ...fields.value, durationMs: fields.value.durationMs }))
})

/** Schema for POST /record/stop request payloads. */
export const recordStopRequestSchema = defineProtocolSchema<RecordStopRequest>((value) => {
	const invalid = requireObject<RecordStopRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		recordId: optionalNonEmptyString,
		outFile: optionalString,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})
