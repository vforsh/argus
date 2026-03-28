import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type * as http from 'node:http'
import { spawn } from 'node:child_process'
import { startServer } from './serve.ts'

const ARGUS_BIN = path.resolve(import.meta.dirname!, '..', 'packages', 'argus', 'src', 'bin.ts')

export type SpawnedJsonResult<T> = {
	proc: ChildProcess
	result: T
}

export type PlaygroundServers = {
	mainServer: http.Server
	crossOriginServer: http.Server
	mainUrl: string
	crossOriginUrl: string
	close: () => Promise<void>
}

/**
 * Start the main playground page server plus the cross-origin iframe server.
 * The returned `close()` shuts both down cleanly.
 */
export const startPlaygroundServers = ({ port, crossOriginPort }: { port: number; crossOriginPort: number }): PlaygroundServers => {
	const mainServer = startServer({ port, crossOriginPort })
	const crossOriginServer = startServer({ port: crossOriginPort })

	return {
		mainServer,
		crossOriginServer,
		mainUrl: `http://127.0.0.1:${port}`,
		crossOriginUrl: `http://127.0.0.1:${crossOriginPort}`,
		close: async () => {
			await closeServer(mainServer)
			await closeServer(crossOriginServer)
		},
	}
}

/**
 * Spawn the local Argus CLI and parse the first stdout line as JSON while keeping the process alive.
 */
export const spawnArgusJson = <T>(args: string[], label: string): Promise<SpawnedJsonResult<T>> =>
	new Promise((resolve, reject) => {
		const proc = spawn('bun', [ARGUS_BIN, ...args], {
			stdio: ['ignore', 'pipe', 'inherit'],
		})

		let buffer = ''
		let resolved = false

		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString()
			const newlineIndex = buffer.indexOf('\n')
			if (newlineIndex === -1) {
				return
			}

			resolved = true
			proc.stdout!.off('data', onData)
			const line = buffer.slice(0, newlineIndex).trim()
			try {
				resolve({ proc, result: JSON.parse(line) as T })
			} catch {
				reject(new Error(`${label} produced invalid JSON:\n${line}`))
			}
		}

		proc.stdout!.on('data', onData)
		proc.on('close', (code) => {
			if (!resolved) {
				reject(new Error(`${label} exited with code ${code} before producing JSON\nstdout: ${buffer}`))
			}
		})
		proc.on('error', (error) => {
			if (!resolved) {
				reject(new Error(`${label} spawn error: ${error.message}`))
			}
		})
	})

export const waitForWatcherReady = async (watcherPort: number, attempts = 50, delayMs = 200): Promise<boolean> => {
	for (let index = 0; index < attempts; index += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${watcherPort}/status`)
			const status = (await response.json()) as { attached?: boolean }
			if (status.attached) {
				return true
			}
		} catch {
			// Ignore connection errors during watcher startup.
		}
		await delay(delayMs)
	}

	return false
}

const closeServer = (server: http.Server): Promise<void> =>
	new Promise((resolve) => {
		server.close(() => resolve())
	})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
