import fs from 'node:fs/promises'
import path from 'node:path'
import { parseDurationMs } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'
import type { PerfRunResult } from '../perf/runResult.js'
import { formatRunReport } from '../perf/report.js'
import { DEFAULT_RECORDER_TRIGGERS, RECORDER_TRIGGERS, type RecorderTrigger } from '../perf/pageRecorder.js'

/** Thrown for bad flags: the command prints the message and exits 2. */
export class PerfUsageError extends Error {}

export const parseDurationFlag = (value: string | undefined, flag: string, fallbackMs?: number): number => {
	if (value == null) {
		if (fallbackMs == null) throw new PerfUsageError(`Missing ${flag}`)
		return fallbackMs
	}
	const ms = parseDurationMs(value)
	if (!ms) throw new PerfUsageError(`Invalid ${flag} value: ${value} (e.g. 5s, 750ms)`)
	return ms
}

export const parseNumberFlag = (value: string | undefined, flag: string, bounds: { min?: number; max?: number; integer?: boolean } = {}): number | undefined => {
	if (value == null) return undefined
	const number = Number(value)
	if (!Number.isFinite(number) || (bounds.integer && !Number.isInteger(number))) throw new PerfUsageError(`Invalid ${flag} value: ${value}`)
	if (bounds.min != null && number < bounds.min) throw new PerfUsageError(`${flag} must be >= ${bounds.min}`)
	if (bounds.max != null && number > bounds.max) throw new PerfUsageError(`${flag} must be <= ${bounds.max}`)
	return number
}

export const parsePointFlag = (value: string | undefined, flag: string): { x: number; y: number } | undefined => {
	if (value == null) return undefined
	const [x, y, ...rest] = value.split(',').map((part) => Number(part.trim()))
	if (rest.length > 0 || !Number.isFinite(x) || !Number.isFinite(y)) throw new PerfUsageError(`Invalid ${flag} value: ${value} (expected x,y)`)
	return { x: x!, y: y! }
}

export const parseClipFlag = (value: string | undefined): { x: number; y: number; width: number; height: number } | undefined => {
	if (value == null) return undefined
	const parts = value.split(',').map((part) => Number(part.trim()))
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2]! <= 0 || parts[3]! <= 0) {
		throw new PerfUsageError(`Invalid --clip value: ${value} (expected x,y,width,height in CSS px)`)
	}
	return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! }
}

export const parseArmOn = (value: string | undefined): 'input' | 'now' => {
	const arm = value ?? 'input'
	if (arm !== 'input' && arm !== 'now') throw new PerfUsageError(`Invalid --arm-on ${arm}; expected input or now`)
	return arm
}

export const parseTriggers = (value: string | undefined): RecorderTrigger[] => {
	if (!value) return DEFAULT_RECORDER_TRIGGERS
	const triggers = value.split(',').map((part) => part.trim()).filter(Boolean)
	const unknown = triggers.find((trigger) => !(RECORDER_TRIGGERS as readonly string[]).includes(trigger))
	if (unknown) throw new PerfUsageError(`Unknown trigger ${unknown}; expected ${RECORDER_TRIGGERS.join(', ')}`)
	return triggers as RecorderTrigger[]
}

/** `--out` / `--keep-trace` resolve against the caller's cwd, like every other Argus output path. */
export const resolveOutPath = (value: string | undefined): string | undefined => (value ? path.resolve(value) : undefined)

/** Write the result file (if asked) and print JSON or the human report. Invalid runs exit 1. */
export const emitRunResult = async (result: PerfRunResult, options: { out?: string; json?: boolean }, output: Output): Promise<void> => {
	const outFile = resolveOutPath(options.out)
	if (outFile) {
		await fs.mkdir(path.dirname(outFile), { recursive: true })
		await fs.writeFile(outFile, `${JSON.stringify(result, null, '\t')}\n`)
	}
	if (options.json) {
		output.writeJson(result)
	} else {
		for (const line of formatRunReport(result)) output.writeHuman(line)
		if (outFile) output.writeHuman(`\nResult written: ${outFile}`)
	}
	if (!result.validity.valid) setExitCode(1)
}

/** Report a thrown error as a usage (exit 2) or runtime (exit 1) failure. */
export const reportPerfError = (error: unknown, output: Output): void => {
	output.writeWarn(error instanceof Error ? error.message : String(error))
	setExitCode(error instanceof PerfUsageError ? 2 : 1)
}
