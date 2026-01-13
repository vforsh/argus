import type { ShutdownResponse } from '@vforsh/argus-core'
import { loadRegistry, pruneRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'

/** Options for the watcher stop command. */
export type WatcherStopOptions = Record<string, never>

/** Execute the watcher stop command. */
export const runWatcherStop = async (id: string, _options: WatcherStopOptions): Promise<void> => {
	const watcherId = id?.trim()
	if (!watcherId) {
		console.error('Watcher id is required.')
		process.exitCode = 2
		return
	}

	let registry = await loadRegistry()
	registry = await pruneRegistry(registry)

	const watcher = registry.watchers[watcherId]
	if (!watcher) {
		console.error(`Watcher not found: ${watcherId}`)
		process.exitCode = 1
		return
	}

	const shutdownUrl = `http://${watcher.host}:${watcher.port}/shutdown`
	try {
		const response = await fetchJson<ShutdownResponse>(shutdownUrl, { method: 'POST', timeoutMs: 2_000 })
		if (response.ok) {
			process.stdout.write(`stopped ${watcher.id}\n`)
			return
		}
	} catch (error) {
		console.error(`warn: shutdown endpoint failed; falling back to SIGTERM (${formatError(error)})`)
	}

	if (watcher.pid == null) {
		console.error(`warn: missing pid for watcher ${watcher.id}; registry entry preserved`)
		process.exitCode = 1
		return
	}

	const pid = watcher.pid
	try {
		process.kill(pid, 'SIGTERM')
	} catch (error) {
		if (isNoSuchProcessError(error)) {
			registry = await removeWatcherAndPersist(registry, watcher.id)
			process.stdout.write(`stopped ${watcher.id}\n`)
			return
		}
		console.error(`warn: failed to stop watcher ${watcher.id}; registry entry preserved (${formatError(error)})`)
		process.exitCode = 1
		return
	}

	const waitResult = await waitForProcessExit(pid, 2_000, 100)
	if (waitResult.state === 'dead') {
		registry = await removeWatcherAndPersist(registry, watcher.id)
		process.stdout.write(`stopped ${watcher.id}\n`)
		return
	}

	const reason = waitResult.error ? ` (${waitResult.error})` : ''
	console.error(`warn: failed to stop watcher ${watcher.id}; registry entry preserved${reason}`)
	process.exitCode = 1
}

type WaitResult = { state: 'dead' | 'timeout' | 'error'; error?: string }

const waitForProcessExit = async (pid: number, timeoutMs: number, intervalMs: number): Promise<WaitResult> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() <= deadline) {
		const check = checkProcessState(pid)
		if (check.state === 'dead') {
			return { state: 'dead' }
		}
		if (check.state === 'error') {
			return { state: 'error', error: check.error }
		}
		await sleep(intervalMs)
	}
	return { state: 'timeout' }
}

const checkProcessState = (pid: number): { state: 'alive' | 'dead' | 'error'; error?: string } => {
	try {
		process.kill(pid, 0)
		return { state: 'alive' }
	} catch (error) {
		if (isNoSuchProcessError(error)) {
			return { state: 'dead' }
		}
		return { state: 'error', error: formatError(error) }
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isNoSuchProcessError = (error: unknown): boolean => {
	return isErrnoError(error) && error.code === 'ESRCH'
}

const isErrnoError = (error: unknown): error is NodeJS.ErrnoException => {
	return !!error && typeof error === 'object' && 'code' in error
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
