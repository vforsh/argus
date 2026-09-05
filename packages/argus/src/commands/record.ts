import path from 'node:path'
import type {
	RecordClipRegion,
	RecordFormat,
	RecordResponse,
	RecordStartResponse,
	RecordStatusResponse,
	RecordStatusSummary,
	RecordStopResponse,
} from '@vforsh/argus-core'
import { RECORD_FORMATS, parseDurationMs } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { resolveArtifactOutFile } from '../utils/paths.js'

const RECORD_STOP_TIMEOUT_MS = 60_000
const RECORD_START_TIMEOUT_MS = 30_000
const RECORD_STATUS_TIMEOUT_MS = 15_000

/** Slack added to a capture's request timeout for first-frame wait plus encoder drain. */
const RECORD_ENCODER_GRACE_MS = 45_000

/** Default ceiling for `--until` so a condition that never fires cannot record forever. */
const DEFAULT_UNTIL_MAX_MS = 60_000

/** Extensions accepted for `--out`, in the order they appear in error messages. */
const RECORD_EXTENSIONS = RECORD_FORMATS.map((format) => `.${format}`)

export type RecordOptions = {
	json?: boolean
	duration?: string
	until?: string
	max?: string
	poll?: string
	out?: string
	selector?: string
	clip?: string
	fps?: string
	format?: string
	quality?: string
}

export type RecordStartOptions = Omit<RecordOptions, 'duration' | 'until' | 'poll'>

export type RecordStopOptions = {
	json?: boolean
	recordId?: string
	out?: string
}

export type RecordStatusOptions = {
	json?: boolean
}

export const runRecord = defineWatcherCommand<RecordOptions, RecordResponse>({
	build: (_args, options, output) => buildRecordPlan(options, output),
	formatHuman: (response, { output }) => writeRecordingSaved(response, output),
})

export const runRecordStart = defineWatcherCommand<RecordStartOptions, RecordStartResponse>({
	build: (_args, options, output) => buildRecordStartPlan(options, output),
	formatHuman: (response, { output }) => {
		output.writeHuman(`Recording started: ${response.recordId}`)
		output.writeHuman(`Session: ${response.sessionName}`)
		output.writeHuman(`Output: ${response.outFile}`)
		output.writeHuman(`Stops automatically after ${formatDurationMs(response.maxDurationMs)} if not stopped sooner.`)
	},
})

export const runRecordStop = defineWatcherCommand<RecordStopOptions, RecordStopResponse>({
	build: (_args, options, output) => buildRecordStopPlan(options, output),
	formatHuman: (response, { output }) => writeRecordingSaved(response, output),
})

export const runRecordStatus = defineWatcherCommand<RecordStatusOptions, RecordStatusResponse>({
	build: () => ({ path: '/record/status', method: 'GET', timeoutMs: RECORD_STATUS_TIMEOUT_MS }),
	formatHuman: (response, { output }) => {
		if (!response.active) {
			output.writeHuman('No active recording.')
			return
		}

		writeActiveRecording(response.active, output)
	},
})

const writeRecordingSaved = (response: RecordStopResponse, output: Output): void => {
	const state = response.partial ? 'Recording saved (partial)' : 'Recording saved'
	output.writeHuman(`${state}: ${response.outFile}`)
	output.writeHuman(
		`${response.frameCount} frames, ${formatDurationMs(response.durationMs)}, ${response.fps} fps, ${formatBytes(response.sizeBytes)}`,
	)
	output.writeHuman(`Stopped by: ${response.stopReason}`)
	if (response.navigations > 0) {
		output.writeHuman(`Survived ${response.navigations} page navigation${response.navigations === 1 ? '' : 's'}.`)
	}
	if (response.partial) {
		output.writeWarn('The page detached before the recording finished; the file holds everything captured up to that point.')
	}
}

const writeActiveRecording = (active: RecordStatusSummary, output: Output): void => {
	output.writeHuman(`Recording: ${active.recordId}`)
	output.writeHuman(`Output: ${active.outFile}`)
	output.writeHuman(
		`${formatDurationMs(active.elapsedMs)} elapsed, ${active.frameCount} frames, ${active.fps} fps, ${active.format}${active.clipped ? ', cropped' : ''}`,
	)
	output.writeHuman(`Auto-stops after ${formatDurationMs(active.maxDurationMs)}.`)
}

const buildRecordPlan = (options: RecordOptions, output: Output): WatcherRequestPlan | null => {
	const bounds = parseCaptureBounds(options, output)
	if (!bounds) {
		return null
	}

	const body = buildRecordBody(options, output)
	if (!body) {
		return null
	}

	return {
		path: '/record',
		method: 'POST',
		body: { ...body, ...bounds },
		// The client must out-wait the watcher's own deadline, or it gives up on a recording that
		// is still running and leaves nobody to collect the file.
		timeoutMs: bounds.maxDurationMs + RECORD_ENCODER_GRACE_MS,
	}
}

type CaptureBounds = { durationMs?: number; until?: string; pollIntervalMs?: number; maxDurationMs: number }

/**
 * Resolve `--duration` / `--until` / `--max` into the bounds the watcher enforces.
 *
 * `--until` is bounded only by `--max`, so that value is sent through as the deadline. `--duration`
 * carries its own end, and `--max` is a backstop that has to sit strictly above it — an equal
 * deadline would race the duration timer and report the wrong stop reason.
 */
const parseCaptureBounds = (options: RecordOptions, output: Output): CaptureBounds | null => {
	if (options.duration && options.until) {
		writeRecordOptionError(output, 'Cannot use both --duration and --until')
		return null
	}

	const maxDurationMs = readOption(options.max, durationParser('--max'), output)
	if (maxDurationMs === null) {
		return null
	}

	if (options.until) {
		const pollIntervalMs = readOption(options.poll, durationParser('--poll', 'ms'), output)
		if (pollIntervalMs === null) {
			return null
		}

		return { until: options.until, pollIntervalMs, maxDurationMs: maxDurationMs ?? DEFAULT_UNTIL_MAX_MS }
	}

	if (!options.duration) {
		writeRecordOptionError(output, 'Missing --duration value. Pass --duration <duration> or --until <expression>.')
		return null
	}

	const durationMs = readOption(options.duration, durationParser('--duration'), output)
	if (durationMs == null) {
		return null
	}

	return { durationMs, maxDurationMs: Math.max(durationMs, maxDurationMs ?? 0) + RECORD_ENCODER_GRACE_MS }
}

const buildRecordStartPlan = (options: RecordStartOptions, output: Output): WatcherRequestPlan | null => {
	const maxDurationMs = readOption(options.max, durationParser('--max'), output)
	if (maxDurationMs === null) {
		return null
	}

	const body = buildRecordBody(options, output)
	if (!body) {
		return null
	}

	return {
		path: '/record/start',
		method: 'POST',
		body: { ...body, maxDurationMs },
		timeoutMs: RECORD_START_TIMEOUT_MS,
	}
}

const buildRecordStopPlan = (options: RecordStopOptions, output: Output): WatcherRequestPlan | null => {
	const outputError = validateRecordOutFile(options.out)
	if (outputError) {
		writeRecordOptionError(output, outputError)
		return null
	}

	return {
		path: '/record/stop',
		method: 'POST',
		body: {
			recordId: normalizeString(options.recordId),
			outFile: resolveArtifactOutFile(options.out),
		},
		timeoutMs: RECORD_STOP_TIMEOUT_MS,
	}
}

const buildRecordBody = (
	options: RecordStartOptions,
	output: Output,
): { outFile?: string; selector?: string; clip?: RecordClipRegion; fps?: number; format: RecordFormat; quality?: number } | null => {
	const clip = readOption(options.clip, parseRecordClipValue, output)
	if (clip === null) {
		return null
	}

	const selector = normalizeString(options.selector)
	if (selector && clip) {
		writeRecordOptionError(output, 'Cannot use both --selector and --clip')
		return null
	}

	const fps = readOption(options.fps, parseRecordFpsValue, output)
	if (fps === null) {
		return null
	}

	const quality = readOption(options.quality, parseRecordQualityValue, output)
	if (quality === null) {
		return null
	}

	const format = parseRecordFormat(options.format, options.out, output)
	if (!format) {
		return null
	}

	return {
		outFile: resolveArtifactOutFile(options.out),
		selector,
		clip,
		fps,
		format,
		quality,
	}
}

/** Build a duration parser for one flag, so durations read through {@link readOption} like everything else. */
const durationParser =
	(flag: string, defaultUnit: 'ms' | 's' = 's') =>
	(value: string | undefined): ParsedOption<number> => {
		if (value == null) {
			return {}
		}

		const parsed = parseDurationMs(value, defaultUnit)
		if (!parsed || parsed <= 0) {
			return { error: `Invalid ${flag} value: ${value}` }
		}

		return { value: parsed }
	}

/** Result of parsing one flag: a value, or the message to show when it is malformed. */
type ParsedOption<T> = { value?: T; error?: string }

/**
 * Read one flag, reporting a malformed value to the user.
 *
 * Returns `undefined` when the flag is absent and `null` when it is present but invalid, which is
 * what lets a caller abort with `if (x === null) return null` while still passing a legitimately
 * absent flag straight through to the request body.
 */
const readOption = <T>(value: string | undefined, parse: (value: string | undefined) => ParsedOption<T>, output: Output): T | undefined | null => {
	const parsed = parse(value)
	if (parsed.error) {
		writeRecordOptionError(output, parsed.error)
		return null
	}

	return parsed.value
}

export const parseRecordFpsValue = (value: string | undefined): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
		return { error: 'Invalid --fps value: expected a number from 1 to 60.' }
	}

	return { value: Math.round(parsed) }
}

export const parseRecordQualityValue = (value: string | undefined): { value?: number; error?: string } => {
	if (value == null) {
		return {}
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
		return { error: 'Invalid --quality value: expected a number from 1 to 100.' }
	}

	return { value: Math.round(parsed) }
}

export const parseRecordClipValue = (value: string | undefined): { value?: RecordClipRegion; error?: string } => {
	if (value == null) {
		return {}
	}

	const parts = value.split(',').map((part) => part.trim())
	if (parts.length !== 4 || parts.some((part) => !part)) {
		return { error: 'Invalid --clip value: expected x,y,width,height.' }
	}

	const [x, y, width, height] = parts.map(Number)
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
		return { error: 'Invalid --clip value: x and y must be finite numbers; width and height must be > 0.' }
	}

	return { value: { x, y, width, height } }
}

export const validateRecordOutFile = (outFile: string | undefined): string | null => {
	const ext = path.extname(outFile?.trim() ?? '').toLowerCase()
	if (!ext || RECORD_EXTENSIONS.includes(ext)) {
		return null
	}
	return `Recording output must use ${formatList(RECORD_EXTENSIONS)} when an extension is provided.`
}

export const parseRecordFormatValue = (value: string | undefined): { value?: RecordFormat; error?: string } => {
	if (value == null) {
		return {}
	}

	const normalized = value.trim().toLowerCase()
	if (isRecordFormat(normalized)) {
		return { value: normalized }
	}

	return { error: `Invalid --format value: expected one of ${RECORD_FORMATS.join(', ')}.` }
}

export const inferRecordFormatFromOutFile = (outFile: string | undefined): RecordFormat | undefined => {
	const ext = path.extname(outFile?.trim() ?? '').toLowerCase()
	const match = RECORD_FORMATS.find((format) => ext === `.${format}`)
	return match
}

export const validateRecordOutFileForFormat = (outFile: string | undefined, format: RecordFormat): string | null => {
	const outputError = validateRecordOutFile(outFile)
	if (outputError) {
		return outputError
	}

	const inferred = inferRecordFormatFromOutFile(outFile)
	return inferred && inferred !== format ? `Output extension .${inferred} does not match --format ${format}.` : null
}

const parseRecordFormat = (value: string | undefined, outFile: string | undefined, output: Output): RecordFormat | null => {
	const parsed = parseRecordFormatValue(value)
	if (parsed.error) {
		writeRecordOptionError(output, parsed.error)
		return null
	}

	const format = parsed.value ?? inferRecordFormatFromOutFile(outFile) ?? 'mp4'
	const outputError = validateRecordOutFileForFormat(outFile, format)
	if (outputError) {
		writeRecordOptionError(output, outputError)
		return null
	}

	return format
}

const isRecordFormat = (value: string): value is RecordFormat => RECORD_FORMATS.includes(value as RecordFormat)

const normalizeString = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

const writeRecordOptionError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 2
}

const formatList = (values: readonly string[]): string =>
	values.length < 2 ? (values[0] ?? '') : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`

const formatDurationMs = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
