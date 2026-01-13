import type { DomInfoResponse, ErrorResponse } from '@vforsh/argus-core'
import { removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatDomInfo } from '../output/dom.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the dom info command. */
export type DomInfoOptions = {
	selector: string
	all?: boolean
	outerHtmlMax?: string
	json?: boolean
	pruneDead?: boolean
}

/** Execute the dom info command for a watcher id. */
export const runDomInfo = async (id: string | undefined, options: DomInfoOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.selector || options.selector.trim() === '') {
		output.writeWarn('--selector is required')
		process.exitCode = 2
		return
	}

	const outerHtmlMaxChars = parsePositiveInt(options.outerHtmlMax)
	if (options.outerHtmlMax !== undefined && outerHtmlMaxChars === undefined) {
		output.writeWarn('--outer-html-max must be a positive integer')
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
	let registry = resolved.registry

	const url = `http://${watcher.host}:${watcher.port}/dom/info`
	let response: DomInfoResponse | ErrorResponse
	try {
		response = await fetchJson<DomInfoResponse | ErrorResponse>(url, {
			method: 'POST',
			body: {
				selector: options.selector,
				all: options.all ?? false,
				outerHtmlMaxChars,
			},
			timeoutMs: 30_000,
			returnErrorResponse: true,
		})
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		if (options.pruneDead) {
			registry = await removeWatcherAndPersist(registry, watcher.id)
		}
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

	const successResp = response as DomInfoResponse

	if (options.json) {
		output.writeJson(successResp)
		return
	}

	if (successResp.matches === 0) {
		output.writeWarn(`No element found for selector: ${options.selector}`)
		process.exitCode = 1
		return
	}

	const formatted = formatDomInfo(successResp.elements)
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
