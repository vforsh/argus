import { readFile } from 'node:fs/promises'
import type { DomFillResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'
import { formatError } from '../cli/parse.js'
import type { Output } from '../output/io.js'
import { resolvePath } from '../utils/paths.js'
import { describeElementTarget, parseWaitDuration, requireElementTarget, writeNoElementFound } from './dom/shared.js'
import { readStdin } from './evalShared.js'

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

/** Execute the dom fill command for a watcher id. The first positional arg is the inline value. */
export const runDomFill = defineWatcherCommand<DomFillOptions, DomFillResponse, unknown, [value: string | undefined]>({
	build: async ([value], options, output) => buildFillPlan(value, options, output),
	formatHuman: (response, { output, options }) => {
		const target = { selector: resolveFillSelector(options), ref: options.ref }
		if (response.matches === 0) {
			writeNoElementFound(target.selector ?? target.ref!, output)
			return
		}
		const elLabel = response.filled === 1 ? '1 element' : `${response.filled} elements`
		output.writeHuman(`Filled ${elLabel} for ${describeElementTarget(target)}`)
	},
})

/** Apply the `--name` shorthand: `--name foo` is equivalent to `--selector '[name="foo"]'`. */
const resolveFillSelector = (options: DomFillOptions): string | undefined => (options.name ? `[name="${options.name}"]` : options.selector)

/** Resolve `--name` shorthand, the value source, and `--wait` into a `/dom/fill` request plan. */
const buildFillPlan = async (value: string | undefined, options: DomFillOptions, output: Output): Promise<WatcherRequestPlan | null> => {
	if (options.name && (options.selector || options.ref)) {
		output.writeWarn('Cannot use --name with --selector or --ref')
		process.exitCode = 2
		return null
	}

	const target = requireElementTarget({ selector: resolveFillSelector(options), ref: options.ref }, output)
	if (!target) return null

	const resolvedValue = await resolveFillValue(value, options, output)
	if (resolvedValue == null) {
		process.exitCode = 2
		return null
	}

	const waitMs = parseWaitDuration(options.wait, output)
	if (waitMs == null) return null

	const body: Record<string, unknown> = {
		value: resolvedValue,
		all: options.all ?? false,
		text: options.text,
	}
	if (target.selector) body.selector = target.selector
	if (target.ref) body.ref = target.ref
	if (waitMs > 0) body.wait = waitMs

	return {
		path: '/dom/fill',
		method: 'POST',
		body,
		timeoutMs: Math.max(30_000, waitMs + 5_000),
	}
}

/** Resolve the fill value from inline arg, --value-file, or --value-stdin. Returns null on error. */
const resolveFillValue = async (value: string | undefined, options: DomFillOptions, output: Output): Promise<string | null> => {
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

	if (hasInline) return value!

	output.writeWarn('Value is required. Provide an inline value, --value-file, or --value-stdin (or pass - as value).')
	return null
}
