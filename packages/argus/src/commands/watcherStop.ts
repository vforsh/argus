import type { ShutdownResponse } from '@vforsh/argus-core'
import { loadActiveRegistry, removeWatcherAndPersist } from '../registry.js'
import { fetchJson } from '../httpClient.js'
import { formatError } from '../cli/parse.js'
import { formatWatcherLine } from '../output/format.js'
import { createOutput } from '../output/io.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'
import { delay } from '@vforsh/argus-core'

/** Options for the watcher stop command. */
export type WatcherStopOptions = { json?: boolean; port?: string }

/** Execute the watcher stop command. */
export const runWatcherStop = async (id: string | undefined, options: WatcherStopOptions): Promise<void> => {
	const output = createOutput(options)
	const writeStopped = (watcherId: string) => {
		if (options.json) output.writeJson({ ok: true, id: watcherId, stopped: true })
		else output.writeHuman(`stopped ${watcherId}`)
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

	const shutdownUrl = `http://${watcher.host}:${watcher.port}/shutdown`
	try {
		const response = await fetchJson<ShutdownResponse>(shutdownUrl, { method: 'POST', timeoutMs: 2_000 })
		if (response.ok) {
			writeStopped(watcher.id)
			return
		}
	} catch (error) {
		output.writeWarn(`warn: shutdown endpoint failed; falling back to SIGTERM (${formatError(error)})`)
	}

	if (watcher.pid == null) {
		output.writeWarn(`warn: missing pid for watcher ${watcher.id}; registry entry preserved`)
		process.exitCode = 1
		return
	}

	const pid = watcher.pid
	try {
		process.kill(pid, 'SIGTERM')
	} catch (error) {
		if (isNoSuchProcessError(error)) {
			await removeWatcherAndPersist(watcher.id, undefined, watcher)
			writeStopped(watcher.id)
			return
		}
		output.writeWarn(`warn: failed to stop watcher ${watcher.id}; registry entry preserved (${formatError(error)})`)
		process.exitCode = 1
		return
	}

	const waitResult = await waitForProcessExit(pid, 2_000, 100)
	if (waitResult.state === 'dead') {
		await removeWatcherAndPersist(watcher.id, undefined, watcher)
		writeStopped(watcher.id)
		return
	}

	const reason = waitResult.error ? ` (${waitResult.error})` : ''
	output.writeWarn(`warn: failed to stop watcher ${watcher.id}; registry entry preserved${reason}`)
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
