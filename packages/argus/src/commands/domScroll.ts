import type { DomScrollResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the dom scroll command. */
export type DomScrollOptions = {
	selector?: string
	to?: string
	by?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom scroll command for a watcher id. */
export const runDomScroll = async (id: string | undefined, options: DomScrollOptions): Promise<void> => {
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

	const result = await requestWatcherJson<DomScrollResponse | ErrorResponse>({
		id,
		path: '/dom/scroll',
		method: 'POST',
		body,
		timeoutMs: 30_000,
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

	const successResp = response as DomScrollResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (hasSelector && successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	if (hasSelector) {
		const label = successResp.scrolled === 1 ? 'element' : 'elements'
		output.writeHuman(`Scrolled ${successResp.scrolled} ${label} (scrollX=${successResp.scrollX}, scrollY=${successResp.scrollY})`)
	} else {
		output.writeHuman(`Scrolled viewport (scrollX=${successResp.scrollX}, scrollY=${successResp.scrollY})`)
	}
}

const parseXY = (value: string): { x: number; y: number } | null => {
	const parts = value.split(',')
	if (parts.length !== 2) {
		return null
	}
	const x = Number(parts[0])
	const y = Number(parts[1])
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return null
	}
	return { x, y }
}
