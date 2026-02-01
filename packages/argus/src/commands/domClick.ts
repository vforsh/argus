import type { DomClickResponse, ErrorResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the dom click command. */
export type DomClickOptions = {
	selector?: string
	pos?: string
	all?: boolean
	text?: string
	json?: boolean
}

/** Execute the dom click command for a watcher id. */
export const runDomClick = async (id: string | undefined, options: DomClickOptions): Promise<void> => {
	const output = createOutput(options)

	const hasSelector = options.selector != null && options.selector.trim() !== ''
	const hasPos = options.pos != null

	if (!hasSelector && !hasPos) {
		output.writeWarn('--selector or --pos is required')
		process.exitCode = 2
		return
	}

	let x: number | undefined
	let y: number | undefined
	if (hasPos) {
		const parts = options.pos!.split(',')
		if (parts.length !== 2) {
			output.writeWarn('--pos must be in the format "x,y" (e.g. --pos 100,200)')
			process.exitCode = 2
			return
		}
		x = Number(parts[0])
		y = Number(parts[1])
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			output.writeWarn('--pos coordinates must be finite numbers')
			process.exitCode = 2
			return
		}
	}

	const body: Record<string, unknown> = {}
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

	const result = await requestWatcherJson<DomClickResponse | ErrorResponse>({
		id,
		path: '/dom/click',
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

	const successResp = response as DomClickResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	// Coordinate-only click
	if (!hasSelector) {
		output.writeHuman(`Clicked at (${x}, ${y})`)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const label = successResp.clicked === 1 ? 'element' : 'elements'
	if (hasPos) {
		output.writeHuman(`Clicked ${successResp.clicked} ${label} for selector: ${options.selector} at offset (${x}, ${y})`)
	} else {
		output.writeHuman(`Clicked ${successResp.clicked} ${label} for selector: ${options.selector}`)
	}
}
