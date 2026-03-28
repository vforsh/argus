import type { DomScrollToResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'
import { parseXY, writeNoElementFound } from './dom/shared.js'

/** Options for the dom scroll-to command. */
export type DomScrollToOptions = {
	selector?: string
	to?: string
	by?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom scroll-to command for a watcher id. */
export const runDomScrollTo = async (id: string | undefined, options: DomScrollToOptions): Promise<void> => {
	const output = createOutput(options)

	const hasSelector = options.selector != null && options.selector.trim() !== ''
	const hasTo = options.to != null
	const hasBy = options.by != null

	if (!hasSelector && !hasTo && !hasBy) {
		output.writeWarn('--selector, --to, or --by is required')
		process.exitCode = 2
		return
	}

	if (hasTo && hasBy) {
		output.writeWarn('--to and --by are mutually exclusive')
		process.exitCode = 2
		return
	}

	let to: { x: number; y: number } | undefined
	let by: { x: number; y: number } | undefined

	if (hasTo) {
		const parsed = parseXY(options.to!)
		if (!parsed) {
			output.writeWarn('--to must be in the format "x,y" (e.g. --to 0,1000)')
			process.exitCode = 2
			return
		}
		to = parsed
	}

	if (hasBy) {
		const parsed = parseXY(options.by!)
		if (!parsed) {
			output.writeWarn('--by must be in the format "x,y" (e.g. --by 0,500)')
			process.exitCode = 2
			return
		}
		by = parsed
	}

	const body: Record<string, unknown> = {}
	if (hasSelector) {
		body.selector = options.selector
		body.all = options.all ?? false
		if (options.text != null) {
			body.text = options.text
		}
	}
	if (to) {
		body.to = to
	}
	if (by) {
		body.by = by
	}

	const result = await requestWatcherAction<DomScrollToResponse>(
		{
			id,
			path: '/dom/scroll-to',
			method: 'POST',
			body,
			timeoutMs: 30_000,
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

	if (hasSelector && successResp.matches === 0) {
		writeNoElementFound(options.selector!, output)
		return
	}

	if (hasSelector) {
		const label = successResp.scrolled === 1 ? 'element' : 'elements'
		output.writeHuman(`Scrolled ${successResp.scrolled} ${label} (scrollX=${successResp.scrollX}, scrollY=${successResp.scrollY})`)
	} else {
		output.writeHuman(`Scrolled viewport (scrollX=${successResp.scrollX}, scrollY=${successResp.scrollY})`)
	}
}
