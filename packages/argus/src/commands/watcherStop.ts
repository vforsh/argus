import type { ShutdownResponse, WatcherRecord } from '@vforsh/argus-core'
import { loadActiveRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatError } from '../cli/parse.js'
import { formatWatcherLine } from '../output/format.js'
import { createOutput, type Output } from '../output/io.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'
import { matchesLabels, parseLabels } from '../watchers/labels.js'
import { delay } from '@vforsh/argus-core'

/** Options for the watcher stop command. */
export type WatcherStopOptions = { json?: boolean; port?: string; label?: string[] }

/** Execute the watcher stop command. */
export const runWatcherStop = async (id: string | undefined, options: WatcherStopOptions): Promise<void> => {
	const output = createOutput(options)
	if (options.label && options.label.length > 0) {
		if (id || options.port !== undefined) {
			output.writeWarn('Cannot combine --label with a watcher id or --port.')
			process.exitCode = 2
			return
		}
		await stopByLabels(options.label, options, output)
		return
	}
	if (options.port !== undefined) {
		const port = Number(options.port)
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			output.writeWarn('Invalid --port: expected a watcher HTTP port (integer 1-65535).')
			process.exitCode = 2
			return
		}
		const registry = await loadActiveRegistry()
		const matches = Object.values(registry.watchers).filter((watcher) => watcher.port === port && (!id || watcher.id === id))
		if (matches.length !== 1) {
			output.writeWarn(`Expected one registered watcher on port ${port}${id ? ` with id ${id}` : ''}; found ${matches.length}. Use --id.`)
			process.exitCode = 2
			return
		}
		id = matches[0].id
	}
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		if (resolved.candidates && resolved.candidates.length > 0) {
			for (const watcher of resolved.candidates) {
				output.writeWarn(formatWatcherLine(watcher))
			}
			output.writeWarn('Hint: run `argus list` to see all watchers.')
		}
		process.exitCode = resolved.exitCode
		return
	}

	const { watcher } = resolved
	if (!(await stopWatcher(watcher, output))) {
		process.exitCode = 1
		return
	}
	if (options.json) output.writeJson({ ok: true, id: watcher.id, stopped: true })
	else output.writeHuman(`stopped ${watcher.id}`)
}

/**
 * Stop every live watcher carrying all given labels. No match is success: label cleanup is idempotent,
 * so an agent can run it on every exit path without checking first.
 */
const stopByLabels = async (labelFlags: string[], options: WatcherStopOptions, output: Output): Promise<void> => {
	const filter = parseLabels(labelFlags)
	if (!filter.ok) {
		output.writeWarn(filter.error)
		process.exitCode = 2
		return
	}
	const registry = await loadActiveRegistry()
	const targets = Object.values(registry.watchers).filter((watcher) => matchesLabels(watcher, filter.labels))
	const results = await Promise.all(targets.map(async (watcher) => ({ id: watcher.id, stopped: await stopWatcher(watcher, output) })))
	const stopped = results.filter((result) => result.stopped).map((result) => result.id)
	const failed = results.filter((result) => !result.stopped).map((result) => result.id)
	if (failed.length > 0) process.exitCode = 1

	if (options.json) {
		output.writeJson({ ok: failed.length === 0, stopped, failed })
		return
	}
	if (targets.length === 0) output.writeHuman('No watchers match.')
	for (const watcherId of stopped) output.writeHuman(`stopped ${watcherId}`)
}

/**
 * Ask the watcher to shut down (closing a Chrome it launched); fall back to SIGTERM on its pid.
 * @returns True once the watcher is gone; false (after a warning) when its registry entry was kept.
 */
const stopWatcher = async (watcher: WatcherRecord, output: Output): Promise<boolean> => {
	const shutdownUrl = `http://${watcher.host}:${watcher.port}/shutdown`
	try {
		const response = await fetchJson<ShutdownResponse>(shutdownUrl, { method: 'POST', timeoutMs: 2_000 })
		if (response.ok) return true
	} catch (error) {
		output.writeWarn(`warn: shutdown endpoint failed; falling back to SIGTERM (${formatError(error)})`)
	}

	if (watcher.pid == null) {
		output.writeWarn(`warn: missing pid for watcher ${watcher.id}; registry entry preserved`)
		return false
	}

	const pid = watcher.pid
	try {
		process.kill(pid, 'SIGTERM')
	} catch (error) {
		if (isNoSuchProcessError(error)) {
			await removeWatcherAndPersist(watcher.id, undefined, watcher)
			return true
		}
		output.writeWarn(`warn: failed to stop watcher ${watcher.id}; registry entry preserved (${formatError(error)})`)
		return false
	}

	const waitResult = await waitForProcessExit(pid, 2_000, 100)
	if (waitResult.state === 'dead') {
		await removeWatcherAndPersist(watcher.id, undefined, watcher)
		return true
	}

	const reason = waitResult.error ? ` (${waitResult.error})` : ''
	output.writeWarn(`warn: failed to stop watcher ${watcher.id}; registry entry preserved${reason}`)
	return false
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
		await delay(intervalMs)
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

const isNoSuchProcessError = (error: unknown): boolean => {
	return isErrnoError(error) && error.code === 'ESRCH'
}

const isErrnoError = (error: unknown): error is NodeJS.ErrnoException => {
	return !!error && typeof error === 'object' && 'code' in error
}
