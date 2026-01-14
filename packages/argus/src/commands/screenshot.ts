import type { ScreenshotResponse } from '@vforsh/argus-core'
import { fetchJson } from '../httpClient.js'
import { createOutput } from '../output/io.js'
import { writeWatcherCandidates } from '../watchers/candidates.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

/** Options for the screenshot command. */
export type ScreenshotOptions = {
	json?: boolean
	out?: string
	selector?: string
}

/** Execute the screenshot command for a watcher id. */
export const runScreenshot = async (id: string | undefined, options: ScreenshotOptions): Promise<void> => {
	const output = createOutput(options)
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

	const url = `http://${watcher.host}:${watcher.port}/screenshot`
	let response: ScreenshotResponse
	try {
		response = await fetchJson<ScreenshotResponse>(url, {
			method: 'POST',
			body: {
				outFile: options.out,
				selector: options.selector,
				format: 'png',
			},
			timeoutMs: 15_000,
		})
	} catch (error) {
		output.writeWarn(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson(response)
		return
	}

	output.writeHuman(`Screenshot saved: ${response.outFile}`)
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
