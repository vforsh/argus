import type { DomScrollResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the dom scroll command. */
export type DomScrollOptions = {
	selector?: string
	pos?: string
	by?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom scroll command (emulate touch scroll gesture) for a watcher id. */
export const runDomScroll = async (id: string | undefined, options: DomScrollOptions): Promise<void> => {
	const output = createOutput(options)

	if (options.by == null) {
		output.writeWarn('--by is required (e.g. --by 0,300)')
		process.exitCode = 2
		return
	}

	const delta = parseXY(options.by)
	if (!delta) {
		output.writeWarn('--by must be in the format "x,y" (e.g. --by 0,300)')
		process.exitCode = 2
		return
	}

	const hasSelector = options.selector != null && options.selector.trim() !== ''
	const hasPos = options.pos != null

	if (hasSelector && hasPos) {
		output.writeWarn('--selector and --pos are mutually exclusive')
		process.exitCode = 2
		return
	}

	let x: number | undefined
	let y: number | undefined
	if (hasPos) {
		const parsed = parseXY(options.pos!)
		if (!parsed) {
			output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 400,300)')
			process.exitCode = 2
			return
		}
		x = parsed.x
		y = parsed.y
	}

	const body: Record<string, unknown> = { delta }
	if (hasSelector) {
		body.selector = options.selector
		body.all = options.all ?? false
		if (options.text != null) {
			body.text = options.text
		}
	}
	if (hasPos) {
		body.x = x
		body.y = y
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

	if (hasSelector) {
		if (successResp.matches === 0) {
			output.writeWarn(`No element found for selector: ${options.selector}`)
			process.exitCode = 1
			return
		}
		const label = successResp.scrolled === 1 ? 'element' : 'elements'
		output.writeHuman(`Emulated scroll on ${successResp.scrolled} ${label} by (${delta.x}, ${delta.y})`)
	} else if (hasPos) {
		output.writeHuman(`Emulated scroll at (${x}, ${y}) by (${delta.x}, ${delta.y})`)
	} else {
		output.writeHuman(`Emulated scroll at viewport center by (${delta.x}, ${delta.y})`)
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
