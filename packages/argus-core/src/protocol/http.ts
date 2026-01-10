import type { LogEvent } from './logs.js'
import type { WatcherRecord } from '../registry/types.js'

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
}

export type LogsResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
}

export type TailResponse = {
	ok: true
	events: LogEvent[]
	nextAfter: number
	timedOut: boolean
}

export type ErrorResponse = {
	ok: false
	error: {
		message: string
		code?: string
	}
}
