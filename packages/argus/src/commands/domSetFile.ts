import fs from 'node:fs'
import type { DomSetFileResponse } from '@vforsh/argus-core'
import { resolvePath } from '../utils/paths.js'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { parseWaitDuration, requireSelector, writeNoElementFound } from './dom/shared.js'

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
	const selector = requireSelector(options, output)
	if (!selector) {
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

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) {
		return
	}

	const body: Record<string, unknown> = {
		selector,
		files,
		all: options.all ?? false,
		text: options.text,
	}
	if (waitMs > 0) {
		body.wait = waitMs
	}

	const result = await requestWatcherAction<DomSetFileResponse>(
		{
			id,
			path: '/dom/set-file',
			method: 'POST',
			body,
			timeoutMs: Math.max(30_000, waitMs + 5_000),
		},
		output,
	)
	if (!result) {
		return
	}
	const successResp = result.data

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		writeNoElementFound(selector, output)
		return
	}

	const fileLabel = files.length === 1 ? '1 file' : `${files.length} files`
	const elLabel = successResp.updated === 1 ? '1 element' : `${successResp.updated} elements`
	output.writeHuman(`Set ${fileLabel} on ${elLabel} for selector: ${selector}`)
}
