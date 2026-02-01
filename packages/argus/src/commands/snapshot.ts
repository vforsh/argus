import type { SnapshotResponse, ErrorResponse } from '@vforsh/argus-core'
import { formatAccessibilityTree } from '../output/accessibility.js'
import { createOutput } from '../output/io.js'
import { parsePositiveInt } from '../cli/parse.js'
import { requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

/** Options for the snapshot command. */
export type SnapshotOptions = {
	selector?: string
	depth?: string
	interactive?: boolean
	json?: boolean
}

/** Execute the snapshot command for a watcher id. */
export const runSnapshot = async (id: string | undefined, options: SnapshotOptions): Promise<void> => {
	const output = createOutput(options)

	const depth = parsePositiveInt(options.depth)
	if (options.depth !== undefined && depth === undefined) {
		output.writeWarn('--depth must be a positive integer')
		process.exitCode = 2
		return
	}

	const result = await requestWatcherJson<SnapshotResponse | ErrorResponse>({
		id,
		path: '/snapshot',
		method: 'POST',
		body: {
			selector: options.selector,
			depth,
			interactive: options.interactive ?? false,
		},
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

	const successResp = response as SnapshotResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.roots.length === 0) {
		output.writeWarn('Accessibility tree is empty.')
		return
	}

	const formatted = formatAccessibilityTree(successResp.roots)
	output.writeHuman(formatted)
}
