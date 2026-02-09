import fs from 'node:fs'
import type { DomSetFileResponse, ErrorResponse } from '@vforsh/argus-core'
import { resolvePath } from '../utils/paths.js'
import { createOutput } from '../output/io.js'
import { parseDurationMs } from '../time.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the dom set-file command. */
export type DomSetFileOptions = {
	selector: string
	file: string[]
	all?: boolean
	text?: string
	wait?: string
	json?: boolean
}

/** Execute the dom set-file command for a watcher id. */
export const runDomSetFile = async (id: string | undefined, options: DomSetFileOptions): Promise<void> => {
	const output = createOutput(options)

	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector or --testid is required')
		process.exitCode = 2
		return
	}

	if (!options.file || options.file.length === 0) {
		output.writeWarn('--file is required (specify one or more file paths)')
		process.exitCode = 2
		return
	}

	// Resolve to absolute paths and validate existence
	const files: string[] = []
	for (const f of options.file) {
		const absolute = resolvePath(f)
		if (!fs.existsSync(absolute)) {
			output.writeWarn(`File not found: ${absolute}`)
			process.exitCode = 2
			return
		}
		files.push(absolute)
	}

	let waitMs = 0
	if (options.wait != null) {
		const parsed = parseDurationMs(options.wait)
		if (parsed == null || parsed < 0) {
			output.writeWarn('Invalid --wait value: expected a duration like 5s, 500ms, 2m.')
			process.exitCode = 2
			return
		}
		waitMs = parsed
	}

	const body: Record<string, unknown> = {
		selector: options.selector,
		files,
		all: options.all ?? false,
		text: options.text,
	}
	if (waitMs > 0) {
		body.wait = waitMs
	}

	const result = await requestWatcherJson<DomSetFileResponse | ErrorResponse>({
		id,
		path: '/dom/set-file',
		method: 'POST',
		body,
		timeoutMs: Math.max(30_000, waitMs + 5_000),
		returnErrorResponse: true,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	const response = result.data
	if (!response.ok) {
		const errorResp = response as ErrorResponse
		if (options.json) {
			output.writeJson(response)
		} else {
			output.writeWarn(`Error: ${errorResp.error.message}`)
		}
		process.exitCode = 1
		return
	}

	const successResp = response as DomSetFileResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const fileLabel = files.length === 1 ? '1 file' : `${files.length} files`
	const elLabel = successResp.updated === 1 ? '1 element' : `${successResp.updated} elements`
	output.writeHuman(`Set ${fileLabel} on ${elLabel} for selector: ${options.selector}`)
}
