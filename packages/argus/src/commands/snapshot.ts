import type { SnapshotResponse, ErrorResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { formatAccessibilityTree } from '../output/accessibility.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

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
	const url = `http://${watcher.host}:${watcher.port}/snapshot`

	let response: SnapshotResponse | ErrorResponse

	try {
		response = await fetchJson<SnapshotResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				selector: options.selector,
				depth,
				interactive: options.interactive ?? false,
			},
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

const parsePositiveInt = (value?: string): number | undefined => {
	if (value === undefined) {
		return undefined
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
		return undefined
	}
	return parsed
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
