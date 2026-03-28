import { readFile } from 'node:fs/promises'
import type { DomFillResponse } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import { readStdin } from './evalShared.js'
import { resolvePath } from '../utils/paths.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { parseWaitDuration, writeNoElementFound } from './dom/shared.js'

/** Options for the dom fill command. */
export type DomFillOptions = {
	selector?: string
	name?: string
	valueFile?: string
	valueStdin?: boolean
	all?: boolean
	text?: string
	wait?: string
	json?: boolean
}

/** Resolve the fill value from inline argument, --value-file, or --value-stdin. Returns null on error. */
const resolveValueInput = async (value: string | undefined, options: DomFillOptions, output: Output): Promise<string | null> => {
	const wantsStdin = options.valueStdin === true || value === '-'
	const hasInline = value != null && value !== '-'
	const hasFile = options.valueFile != null

	const sourceCount = [hasInline, hasFile, wantsStdin].filter(Boolean).length
	if (sourceCount > 1) {
		output.writeWarn('Provide only one of: inline value, --value-file, or --value-stdin')
		return null
	}

	if (hasFile) {
		try {
			const content = await readFile(resolvePath(options.valueFile!), 'utf8')
			if (!content.trim()) {
				output.writeWarn(`File is empty: ${options.valueFile}`)
				return null
			}
			return content
		} catch (error) {
			output.writeWarn(`Failed to read --value-file: ${formatError(error)}`)
			return null
		}
	}

	if (wantsStdin) {
		try {
			const content = await readStdin()
			if (!content.trim()) {
				output.writeWarn('Stdin input is empty')
				return null
			}
			return content
		} catch (error) {
			output.writeWarn(`Failed to read stdin: ${formatError(error)}`)
			return null
		}
	}

	if (hasInline) {
		return value!
	}

	output.writeWarn('Value is required. Provide an inline value, --value-file, or --value-stdin (or pass - as value).')
	return null
}

/** Execute the dom fill command for a watcher id. */
export const runDomFill = async (id: string | undefined, value: string | undefined, options: DomFillOptions): Promise<void> => {
	const output = createOutput(options)

	if (options.name && options.selector) {
		output.writeWarn('Cannot use both --name and --selector')
		process.exitCode = 2
		return
	}

	if (options.name) {
		options.selector = `[name="${options.name}"]`
	}

	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector, --name, or --testid is required')
		process.exitCode = 2
		return
	}

	const resolvedValue = await resolveValueInput(value, options, output)
	if (resolvedValue == null) {
		process.exitCode = 2
		return
	}

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) {
		return
	}

	const body: Record<string, unknown> = {
		selector: options.selector,
		value: resolvedValue,
		all: options.all ?? false,
		text: options.text,
	}
	if (waitMs > 0) {
		body.wait = waitMs
	}

	const result = await requestWatcherAction<DomFillResponse>(
		{
			id,
			path: '/dom/fill',
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
		writeNoElementFound(options.selector, output)
		return
	}

	const elLabel = successResp.filled === 1 ? '1 element' : `${successResp.filled} elements`
	output.writeHuman(`Filled ${elLabel} for selector: ${options.selector}`)
}
