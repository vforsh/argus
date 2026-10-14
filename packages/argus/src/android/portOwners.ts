import { loadActiveRegistry } from '../registry.js'

/** The registered watcher whose CDP endpoint is this host port, so a forward can be traced to its session. */
export const findWatcherOnChromePort = async (port: number): Promise<{ id: string; cwd?: string } | null> => {
	try {
		const registry = await loadActiveRegistry()
		const watcher = Object.values(registry.watchers).find((record) => record.chrome?.port === port && isLoopback(record.chrome.host))
		return watcher ? { id: watcher.id, cwd: watcher.cwd } : null
	} catch {
		return null
	}
}

const isLoopback = (host: string): boolean => host === 'localhost' || host.startsWith('127.')
