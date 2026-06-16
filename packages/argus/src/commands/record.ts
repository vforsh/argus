import path from 'node:path'
import type { RecordClipRegion, RecordResponse, RecordStartResponse, RecordStopResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { parseDurationMs } from '../time.js'

const RECORD_STOP_TIMEOUT_MS = 60_000
const RECORD_START_TIMEOUT_MS = 30_000
const RECORD_ENCODER_GRACE_MS = 30_000

export type RecordOptions = {
	json?: boolean
	duration?: string
	out?: string
	selector?: string
	clip?: string
	fps?: string
}

export type RecordStartOptions = Omit<RecordOptions, 'duration'>

export type RecordStopOptions = {
	json?: boolean
	recordId?: string
	out?: string
}

export const runRecord = defineWatcherCommand<RecordOptions, RecordResponse>({
	build: (_args, options, output) => buildRecordPlan(options, output),
	formatHuman: (response, { output }) => {
		output.writeHuman(`Recording saved: ${response.outFile} (${response.frameCount} frames, ${formatDurationMs(response.durationMs)})`)
	},
})

export const runRecordStart = defineWatcherCommand<RecordStartOptions, RecordStartResponse>({
	build: (_args, options, output) => buildRecordStartPlan(options, output),
	formatHuman: (response, { output }) => {
		output.writeHuman(`Recording started: ${response.recordId}`)
		output.writeHuman(`Session: ${response.sessionName}`)
		output.writeHuman(`Output: ${response.outFile}`)
	},
})

export const runRecordStop = defineWatcherCommand<RecordStopOptions, RecordStopResponse>({
	build: (_args, options) => ({
		path: '/record/stop',
		method: 'POST',
		body: {
			recordId: normalizeString(options.recordId),
			outFile: options.out,
		},
		timeoutMs: RECORD_STOP_TIMEOUT_MS,
	}),
	formatHuman: (response, { output }) => {
		output.writeHuman(`Recording saved: ${response.outFile} (${response.frameCount} frames, ${formatDurationMs(response.durationMs)})`)
	},
})

const buildRecordPlan = (options: RecordOptions, output: Output): WatcherRequestPlan | null => {
	const durationMs = parseRecordDuration(options.duration, output)
	if (durationMs == null) {
		return null
	}

	const body = buildRecordBody(options, output)
	if (!body) {
		return null
	}

	return {
		path: '/record',
		method: 'POST',
		body: {
			...body,
			durationMs,
		},
		timeoutMs: durationMs + RECORD_ENCODER_GRACE_MS,
	}
}

const buildRecordStartPlan = (options: RecordStartOptions, output: Output): WatcherRequestPlan | null => {
	const body = buildRecordBody(options, output)
	if (!body) {
		return null
	}

	return {
		path: '/record/start',
		method: 'POST',
		body,
		timeoutMs: RECORD_START_TIMEOUT_MS,
	}
}

const buildRecordBody = (
	options: RecordStartOptions,
	output: Output,
): { outFile?: string; selector?: string; clip?: RecordClipRegion; fps?: number; format: 'webm' } | null => {
	const clip = parseRecordClip(options.clip, output)
	if (clip === null) {
		return null
	}

	const selector = normalizeString(options.selector)
	if (selector && clip) {
		writeRecordOptionError(output, 'Cannot use both --selector and --clip')
		return null
	}

	const fps = parseRecordFps(options.fps, output)
	if (fps === null) {
		return null
	}

	if (!validateWebmOutput(options.out, output)) {
		return null
	}

	return {
		outFile: options.out,
		selector,
		clip,
		fps,
		format: 'webm',
	}
}

const parseRecordDuration = (value: string | undefined, output: Output): number | null => {
	if (!value) {
		writeRecordOptionError(output, 'Missing --duration value')
		return null
	}

	const parsed = parseDurationMs(value)
	if (!parsed || parsed <= 0) {
		writeRecordOptionError(output, `Invalid --duration value: ${value}`)
		return null
	}

	return parsed
}

const parseRecordFps = (value: string | undefined, output: Output): number | undefined | null => {
	const parsed = parseRecordFpsValue(value)
	if (parsed.error) {
		writeRecordOptionError(output, parsed.error)
		return null
	}

	return parsed.value
}

const parseRecordClip = (value: string | undefined, output: Output): RecordClipRegion | undefined | null => {
	const parsed = parseRecordClipValue(value)
	if (parsed.error) {
		writeRecordOptionError(output, parsed.error)
		return null
	}

	return parsed.value
}

const validateWebmOutput = (outFile: string | undefined, output: Output): boolean => {
	const error = validateRecordOutFile(outFile)
	if (error) {
		writeRecordOptionError(output, error)
		return false
	}
	return true
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
	return ext && ext !== '.webm' ? 'Only WebM output is supported in this version. Use --out <file>.webm.' : null
}

const normalizeString = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

const writeRecordOptionError = (output: Output, message: string): void => {
	output.writeWarn(message)
	process.exitCode = 2
}

const formatDurationMs = (ms: number): string => `${(ms / 1000).toFixed(3)}s`
