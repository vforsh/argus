import type { EvalResponse } from '@vforsh/argus-core'
import { previewStringify } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'

/** Options for the eval command. */
export type EvalOptions = {
	json?: boolean
	await?: boolean
	timeout?: string
	returnByValue?: boolean
}

/** Execute the eval command for a watcher id. */
export const runEval = async (id: string, expression: string, options: EvalOptions): Promise<void> => {
	if (!expression || expression.trim() === '') {
		console.error('Expression is required')
		process.exitCode = 2
		return
	}

	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[id]
	if (!watcher) {
		console.error(`Watcher not found: ${id}`)
		process.exitCode = 1
		return
	}

	const timeoutMs = parseNumber(options.timeout)

	const url = `http://${watcher.host}:${watcher.port}/eval`
	let response: EvalResponse
	try {
		response = await fetchJson<EvalResponse>(url, {
			method: 'POST',
			body: {
				expression,
				awaitPromise: options.await ?? true,
				returnByValue: options.returnByValue ?? true,
				timeoutMs,
			},
			timeoutMs: timeoutMs ? timeoutMs + 5_000 : 10_000,
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

	if (response.exception) {
		process.stdout.write(`Exception: ${response.exception.text}\n`)
		if (response.exception.details) {
			process.stdout.write(`${previewStringify(response.exception.details)}\n`)
		}
		return
	}

	process.stdout.write(`${previewStringify(response.result)}\n`)
}

const parseNumber = (value?: string): number | undefined => {
	if (!value) {
		return undefined
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
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
