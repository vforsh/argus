import fs from 'node:fs'
import type { DomSetFileResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import type { Output } from '../output/io.js'
import { resolvePath } from '../utils/paths.js'
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
export const runDomSetFile = defineWatcherCommand<DomSetFileOptions, DomSetFileResponse>({
	build: (_args, options, output) => buildSetFilePlan(options, output),
	formatHuman: (response, { output, options }) => {
		if (response.matches === 0) {
			writeNoElementFound(options.selector, output)
			return
		}
		const fileLabel = options.file.length === 1 ? '1 file' : `${options.file.length} files`
		const elLabel = response.updated === 1 ? '1 element' : `${response.updated} elements`
		output.writeHuman(`Set ${fileLabel} on ${elLabel} for selector: ${options.selector}`)
	},
})

const buildSetFilePlan = (options: DomSetFileOptions, output: Output): WatcherRequestPlan | null => {
	const selector = requireSelector(options, output)
	if (!selector) return null

	if (!options.file || options.file.length === 0) {
		output.writeWarn('--file is required (specify one or more file paths)')
		process.exitCode = 2
		return null
	}

	// Resolve to absolute paths and validate existence before sending to the watcher.
	const files: string[] = []
	for (const f of options.file) {
		const absolute = resolvePath(f)
		if (!fs.existsSync(absolute)) {
			output.writeWarn(`File not found: ${absolute}`)
			process.exitCode = 2
			return null
		}
		files.push(absolute)
	}

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) return null

	const body: Record<string, unknown> = {
		selector,
		files,
		all: options.all ?? false,
		text: options.text,
	}
	if (waitMs > 0) body.wait = waitMs

	return {
		path: '/dom/set-file',
		method: 'POST',
		body,
		timeoutMs: Math.max(30_000, waitMs + 5_000),
	}
}
