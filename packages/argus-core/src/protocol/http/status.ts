import type { WatcherRecord } from '../../registry/types.js'
import type { ArgusProtocolVersion } from '../version.js'

/** Response payload for GET /status. */
export type StatusResponse = {
	ok: true
	id: string
	pid: number
	attached: boolean
	target: {
		title: string | null
		url: string | null
	} | null
	buffer: {
		size: number
		count: number
		minId: number | null
		maxId: number | null
	}
	watcher: WatcherRecord
	/** Protocol version advertised by the watcher. */
	protocolVersion?: ArgusProtocolVersion
	/** Watcher package version (e.g. "0.1.2"). */
	watcherVersion?: string
}

/** Response payload for POST /shutdown. */
export type ShutdownResponse = {
	ok: true
}

/** Request payload for POST /reload. */
export type ReloadRequest = {
	/** If true, bypass browser cache. Default: false. */
	ignoreCache?: boolean
}

/** Response payload for POST /reload. */
export type ReloadResponse = {
	ok: true
}
