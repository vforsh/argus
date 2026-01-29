import type { DomClickResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the dom click command. */
export type DomClickOptions = {
	selector?: string
	pos?: string
	all?: boolean
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
	const url = `http://${watcher.host}:${watcher.port}/dom/click`

	const body: Record<string, unknown> = {}
	if (hasSelector) {
		body.selector = options.selector
		body.all = options.all ?? false
	}
	if (hasPos) {
		body.x = x
		body.y = y
	}

	let response: DomClickResponse | ErrorResponse

	try {
		response = await fetchJson<DomClickResponse | ErrorResponse>(url, {
			method: 'POST',
			body,
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

const formatError = (error: unknown): string => {
	if (!error) {
		return 'unknown error'
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}
