import type { ScreenshotResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'

/** Options for the screenshot command. */
export type ScreenshotOptions = {
	json?: boolean
	out?: string
	selector?: string
}

/** Execute the screenshot command for a watcher id. */
export const runScreenshot = async (id: string, options: ScreenshotOptions): Promise<void> => {
	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return
	}

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
		console.error(`${watcher.id}: failed to reach watcher (${formatError(error)})`)
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.exitCode = 1
		return
	}

	if (options.json) {
		process.stdout.write(JSON.stringify(response))
		return
	}

	process.stdout.write(`Screenshot saved: ${response.outFile}\n`)
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
