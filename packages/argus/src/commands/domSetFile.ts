import fs from 'node:fs'
import path from 'node:path'
import type { DomSetFileResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the dom set-file command. */
export type DomSetFileOptions = {
	selector: string
	file: string[]
	all?: boolean
	json?: boolean
}

/** Execute the dom set-file command for a watcher id. */
export const runDomSetFile = async (id: string | undefined, options: DomSetFileOptions): Promise<void> => {
	const output = createOutput(options)

	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector is required')
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
		const absolute = path.resolve(f)
		if (!fs.existsSync(absolute)) {
			output.writeWarn(`File not found: ${absolute}`)
			process.exitCode = 2
			return
		}
		files.push(absolute)
	}

	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			writeWatcherCandidates(resolved.candidates, output)
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const { watcher } = resolved
	const url = `http://${watcher.host}:${watcher.port}/dom/set-file`

	let response: DomSetFileResponse | ErrorResponse

	try {
		response = await fetchJson<DomSetFileResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				selector: options.selector,
				files,
				all: options.all ?? false,
			},
			timeoutMs: 30_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return
	}

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

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
