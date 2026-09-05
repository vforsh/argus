import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalEnum, optionalNonEmptyString, optionalNumber, optionalString, readFields, requireObject } from '../schemaFields.js'
import { optionalClipRegion, requireSingleCaptureTarget } from './screenshot.js'

import type { ScreenshotClipRegion } from './screenshot.js'
import type { Ok } from './errors.js'

/** Viewport-relative crop rectangle in CSS pixels. */
export type RecordClipRegion = ScreenshotClipRegion

/** Supported recording containers/codecs. */
export const RECORD_FORMATS = ['mp4', 'webm', 'gif'] as const

/** Recording container/codec preset. */
export type RecordFormat = (typeof RECORD_FORMATS)[number]

/**
 * Highest frame rate GIF encodes cleanly.
 *
 * GIF frame delays are stored in centiseconds, so only rates that divide 100 are exact; anything
 * faster than this rounds to the same delay and just inflates the file. Requests above the cap are
 * clamped rather than rejected — the caller asked for a GIF, not for a specific timebase.
 */
export const RECORD_GIF_MAX_FPS = 20

/** Default frame rate for GIF output, chosen for size over smoothness. */
export const RECORD_GIF_DEFAULT_FPS = 12

/** Why a recording stopped. */
export const RECORD_STOP_REASONS = ['requested', 'duration', 'until', 'max-duration', 'detached'] as const

/** Why a recording stopped. `detached` means the page or CDP session went away mid-capture. */
export type RecordStopReason = (typeof RECORD_STOP_REASONS)[number]

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
	/** Output frames per second. Defaults to 30 (12 for GIF). */
	fps?: number
	/** Output format. Defaults to mp4 unless inferred from outFile extension. */
	format?: RecordFormat
	/**
	 * JPEG quality (1-100) for the screencast frames fed to the encoder. Defaults to 90.
	 *
	 * This is the *intermediate* quality, not the output bitrate. Chrome's screencast is the
	 * bottleneck on large canvases, and PNG frames cost several times more to serialize than JPEG
	 * for no visible gain once the result is re-encoded to H.264/VP9.
	 */
	quality?: number
	/**
	 * Stop automatically after this many milliseconds.
	 *
	 * A safety net, not a schedule: an open-ended `record start` that is never stopped otherwise
	 * runs an ffmpeg child until the watcher dies. Defaults to {@link RECORD_DEFAULT_MAX_DURATION_MS}.
	 */
	maxDurationMs?: number
}

/** Default auto-stop deadline applied when a caller names none. */
export const RECORD_DEFAULT_MAX_DURATION_MS = 600_000

/** Default interval between `until` expression evaluations. */
export const RECORD_DEFAULT_POLL_INTERVAL_MS = 250

/** Request payload for POST /record. */
export type RecordRequest = RecordOptions & {
	/** Capture duration in milliseconds. Required unless `until` is supplied. */
	durationMs?: number
	/**
	 * Record until this expression evaluates truthy in the page, then stop.
	 *
	 * Evaluated against the selected target (an iframe, when one is selected), the same way
	 * `eval` resolves its target. Mutually exclusive with `durationMs`.
	 */
	until?: string
	/** Interval between `until` evaluations. Defaults to {@link RECORD_DEFAULT_POLL_INTERVAL_MS}. */
	pollIntervalMs?: number
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
	/** Wall-clock deadline after which the watcher stops the recording on its own. */
	maxDurationMs: number
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
	/** Why the recording ended. */
	stopReason: RecordStopReason
	/**
	 * True when the file holds less than the caller asked for.
	 *
	 * Set when the session detached mid-capture. The file is still finalized and playable — a
	 * truncated repro clip beats a corrupt one — but it is not the full requested window.
	 */
	partial: boolean
	/** Top-frame navigations survived during the capture, each one re-arming the screencast. */
	navigations: number
	/** Size of the written file in bytes. */
	sizeBytes: number
}>

export type RecordResponse = RecordStopResponse

/** Live recording summary, shared by GET /record/status and GET /status. */
export type RecordStatusSummary = {
	recordId: string
	sessionName: string
	outFile: string
	format: RecordFormat
	fps: number
	clipped: boolean
	/** Epoch milliseconds when frames started flowing. */
	startedAt: number
	/** Milliseconds captured so far. */
	elapsedMs: number
	/** Frames written to the encoder so far. */
	frameCount: number
	/** Wall-clock deadline after which the watcher stops on its own. */
	maxDurationMs: number
	/** Top-frame navigations survived so far. */
	navigations: number
}

/** Response payload for GET /record/status. */
export type RecordStatusResponse = Ok<{
	recording: boolean
	/** Present only while a recording is active. */
	active: RecordStatusSummary | null
}>

/** Readers for the outFile/selector/clip/fps/format options every record route shares. */
const recordOptionReaders = {
	outFile: optionalString,
	selector: optionalNonEmptyString,
	clip: optionalClipRegion,
	fps: (source: Record<string, unknown>, key: string) => optionalNumber(source, key, { min: 1, max: 60 }),
	format: (source: Record<string, unknown>, key: string) => optionalEnum(source, key, RECORD_FORMATS),
	quality: (source: Record<string, unknown>, key: string) => optionalNumber(source, key, { min: 1, max: 100 }),
	maxDurationMs: (source: Record<string, unknown>, key: string) => optionalNumber(source, key, { min: Number.EPSILON }),
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

/** Schema for POST /record request payloads (duration- or condition-bounded capture). */
export const recordRequestSchema = defineProtocolSchema<RecordRequest>((value) => {
	const invalid = requireObject<RecordRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		...recordOptionReaders,
		durationMs: (source, key) => optionalNumber(source, key, { min: Number.EPSILON }),
		until: optionalNonEmptyString,
		pollIntervalMs: (source, key) => optionalNumber(source, key, { min: 10 }),
	})
	if (!fields.ok) return fields

	const conflict = requireSingleCaptureTarget(fields.value)
	if (conflict) return invalidProtocolPayload(conflict)

	if (fields.value.durationMs != null && fields.value.until != null) {
		return invalidProtocolPayload('durationMs and until are mutually exclusive')
	}
	if (fields.value.durationMs == null && fields.value.until == null) {
		return invalidProtocolPayload('durationMs must be greater than 0, or until must name an expression')
	}

	return validProtocolPayload(compact(fields.value))
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
