import { readFile } from 'node:fs/promises'
import type { DomFillResponse } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import { readStdin } from './evalShared.js'
import { resolvePath } from '../utils/paths.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { describeElementTarget, parseWaitDuration, requireElementTarget, writeNoElementFound } from './dom/shared.js'

/** Options for the dom fill command. */
export type DomFillOptions = {
	selector?: string
	ref?: string
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

	if (options.name && (options.selector || options.ref)) {
		output.writeWarn('Cannot use --name with --selector or --ref')
		process.exitCode = 2
		return
	}

	if (options.name) {
		options.selector = `[name="${options.name}"]`
	}

	const target = requireElementTarget({ selector: options.selector, ref: options.ref }, output)
	if (!target) {
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
		value: resolvedValue,
		all: options.all ?? false,
		text: options.text,
	}
	if (target.selector) {
		body.selector = target.selector
	}
	if (target.ref) {
		body.ref = target.ref
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
		writeNoElementFound(target.selector ?? target.ref!, output)
		return
	}

	const elLabel = successResp.filled === 1 ? '1 element' : `${successResp.filled} elements`
	output.writeHuman(`Filled ${elLabel} for ${describeElementTarget(target)}`)
}
