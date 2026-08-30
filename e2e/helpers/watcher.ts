import { runCommandWithExit, type CommandOptions } from './process.js'

/**
 * Wait until a watcher reports it is attached to a CDP target.
 *
 * A watcher process prints its id — which is what `spawnAndWait` matches on — before it
 * has finished attaching, so a command issued right after startup can fail with
 * "Watcher not attached to a CDP target". Tests that start a watcher and immediately act
 * on it must wait for this.
 *
 * @param binPath Path to the built CLI entry point.
 * @param watcherId Watcher to poll. Resolved through the registry, so no port is needed.
 * @throws {Error} When the watcher does not attach within the timeout.
 */
export async function waitForWatcherAttached(
	binPath: string,
	watcherId: string,
	options: CommandOptions & { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const { timeoutMs = 10_000, intervalMs = 200, ...commandOptions } = options
	const deadline = Date.now() + timeoutMs

	while (Date.now() < deadline) {
		const { stdout, code } = await runCommandWithExit('bun', [binPath, 'watcher', 'status', watcherId, '--json'], commandOptions)
		if (code === 0) {
			try {
				if ((JSON.parse(stdout) as { attached?: boolean }).attached === true) {
					return
				}
			} catch {
				// Watcher answered mid-startup with something unparseable; keep polling.
			}
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}

	throw new Error(`Watcher ${watcherId} did not attach within ${timeoutMs}ms`)
}

/**
 * Wait until a watcher's HTTP server reports it is attached.
 *
 * Same contract as {@link waitForWatcherAttached}, for tests that hold the watcher's port
 * directly and have no registry entry to resolve.
 */
export async function waitForWatcherPortAttached(port: number, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
	const { timeoutMs = 10_000, intervalMs = 200 } = options
	const deadline = Date.now() + timeoutMs

	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/status`)
			if (((await response.json()) as { attached?: boolean }).attached === true) {
				return
			}
		} catch {
			// Server not up yet.
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}

	throw new Error(`Watcher on port ${port} did not attach within ${timeoutMs}ms`)
}
