/** Target matching rules for CDP selection. */
export type WatcherMatch = {
	url?: string
	title?: string
	urlRegex?: string
	titleRegex?: string
}

/** Chrome CDP connection details. */
export type WatcherChrome = {
	host: string
	port: number
}

/** Registry entry for a watcher instance. */
export type WatcherRecord = {
	id: string
	host: string
	port: number
	pid: number
	startedAt: number
	updatedAt: number
	match?: WatcherMatch
	chrome?: WatcherChrome
}

/** Registry schema v1. */
export type RegistryV1 = {
	version: 1
	updatedAt: number
	watchers: Record<string, WatcherRecord>
}

/** Result of reading the registry file with warnings. */
export type RegistryReadResult = {
	registry: RegistryV1
	warnings: string[]
}
