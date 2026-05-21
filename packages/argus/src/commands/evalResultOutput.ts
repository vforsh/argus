import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
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
		const details = response.exception.details ? `\n${previewStringify(response.exception.details)}` : ''
		return `Exception: ${response.exception.text}${details}\n`
	}

	return `${previewStringify(response.result)}\n`
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
