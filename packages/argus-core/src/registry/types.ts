export type WatcherMatch = {
	url?: string
	title?: string
	urlRegex?: string
	titleRegex?: string
}

export type WatcherChrome = {
	host: string
	port: number
}

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

export type RegistryV1 = {
	version: 1
	updatedAt: number
	watchers: Record<string, WatcherRecord>
}

export type RegistryReadResult = {
	registry: RegistryV1
	warnings: string[]
}
