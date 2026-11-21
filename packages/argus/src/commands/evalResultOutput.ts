import type { EvalResponse } from '@vforsh/argus-core'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Output } from '../output/io.js'
import { resolvePath } from '../utils/paths.js'

/** Options for writing eval results to `--out`. */
export type EvalResultFileOptions = {
	out?: string
	rotate?: boolean
	json?: boolean
}

/** Sink that persists eval responses to disk. */
export type EvalResultFileSink = {
	write: (response: EvalResponse, streaming: boolean) => Promise<void>
	displayPath: string
}

/**
 * Validate `--out` / `--rotate` usage for eval commands.
 * Returns `false` and sets exit code 2 when invalid.
 */
export const validateEvalResultFileOptions = (options: EvalResultFileOptions & { interval?: string }, output: Output): boolean => {
	if (options.rotate && !options.out) {
		output.writeWarn('Invalid --rotate usage: requires --out')
		process.exitCode = 2
		return false
	}

	if (options.rotate && options.interval == null) {
		output.writeWarn('Invalid --rotate usage: requires --interval')
		process.exitCode = 2
		return false
	}

	return true
}

/** Create a file sink when `--out` is set; otherwise `null`. */
export const createEvalResultFileSink = (options: EvalResultFileOptions): EvalResultFileSink | null => {
	if (!options.out) {
		return null
	}

	return createEvalResultFileSinkAtPath(resolvePath(options.out), options.json === true, options.rotate === true)
}

const createEvalResultFileSinkAtPath = (outPath: string, json: boolean, rotate: boolean): EvalResultFileSink => {
	let appendReady = false
	let rotateIndex = 0

	const prepareAppendTarget = async (): Promise<void> => {
		if (appendReady) {
			return
		}

		await ensureParentDir(outPath)
		await writeFile(outPath, '', 'utf8')
		appendReady = true
	}

	return {
		displayPath: outPath,
		write: async (response, streaming) => {
			if (streaming && rotate) {
				rotateIndex += 1
				const iterationPath = formatRotatedPath(outPath, rotateIndex)
				await writeResultFile(iterationPath, formatResultPayload(response, json))
				return
			}

			if (streaming) {
				await prepareAppendTarget()
				await appendFile(outPath, `${JSON.stringify(response)}\n`, 'utf8')
				return
			}

			await writeResultFile(outPath, formatResultPayload(response, json))
		},
	}
}

/** Insert a zero-padded counter before the file extension (`result.json` → `result.0001.json`). */
export const formatRotatedPath = (outPath: string, index: number): string => {
	const parsed = path.parse(outPath)
	const suffix = String(index).padStart(4, '0')
	const extension = parsed.ext || '.json'
	return path.join(parsed.dir, `${parsed.name}.${suffix}${extension}`)
}

const formatResultPayload = (response: EvalResponse, json: boolean): string => {
	if (json) {
		return `${JSON.stringify(response, null, 2)}\n`
	}

	if (response.exception) {
		return `${formatException(response)}\n`
	}

	return `${formatEvalValue(response.result)}\n`
}

/** Stack frames kept under the message; the rest are counted, not printed. */
const STACK_FRAMES_SHOWN = 2

/**
 * Human text for an eval that threw: an Error's own message plus its top stack frames, or the thrown value.
 *
 * This used to print `Exception: Uncaught` followed by CDP's raw RemoteObject (`className`, `objectId`, …):
 * 97 agent outputs in one week carried that dump. Errors print their description; any other thrown value
 * prints as `Uncaught <value>`, read from the RemoteObject's `value`/`unserializableValue`, because a
 * primitive's `description` (`0`) would drop its type and `undefined` has none.
 */
export const formatException = (response: EvalResponse): string => {
	const exception = response.exception
	if (!exception) return ''
	const thrown = (exception.details && typeof exception.details === 'object' ? exception.details : {}) as ThrownObject
	if (thrown.subtype === 'error' && typeof thrown.description === 'string') return trimStackFrames(thrown.description)
	const value = describeThrownValue(thrown)
	return value === undefined ? `Exception: ${exception.text}` : `${exception.text} ${value}`
}

/** The parts of a CDP `Runtime.RemoteObject` the formatter reads. */
type ThrownObject = { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string }

const describeThrownValue = (thrown: ThrownObject): string | undefined => {
	if (thrown.type === 'undefined') return 'undefined'
	if (thrown.unserializableValue) return thrown.unserializableValue
	if ('value' in thrown) return JSON.stringify(thrown.value)
	return thrown.description || undefined
}

/** CDP puts the thrown value's `description` (message + stack) on `details`; keep only that. */
export const describeExceptionDetails = (details: unknown): string | undefined => {
	if (!details || typeof details !== 'object') return undefined
	const description = (details as { description?: unknown }).description
	return typeof description === 'string' && description !== '' ? description : undefined
}

/**
 * Keep the message and the first {@link STACK_FRAMES_SHOWN} frames of the stack: the trailing run of
 * `    at …` lines. Only the suffix counts, so a message that itself contains an indented "at" line stays whole.
 */
const trimStackFrames = (description: string): string => {
	const lines = description.split('\n')
	let stackStart = lines.length
	while (stackStart > 0 && /^\s+at /.test(lines[stackStart - 1]!)) stackStart -= 1
	const kept = lines.slice(0, stackStart + STACK_FRAMES_SHOWN)
	const hidden = lines.length - kept.length
	return hidden > 0 ? `${kept.join('\n')}\n    … ${hidden} more frame${hidden === 1 ? '' : 's'}` : kept.join('\n')
}

/** Format a serialized eval value without truncating nested objects, arrays, or strings. */
export const formatEvalValue = (value: unknown): string => {
	if (typeof value === 'string') return value
	return JSON.stringify(value) ?? String(value)
}

const writeResultFile = async (filePath: string, payload: string): Promise<void> => {
	await ensureParentDir(filePath)
	await writeFile(filePath, payload, 'utf8')
}

const ensureParentDir = async (filePath: string): Promise<void> => {
	const parent = path.dirname(filePath)
	if (parent && parent !== '.') {
		await mkdir(parent, { recursive: true })
	}
}
