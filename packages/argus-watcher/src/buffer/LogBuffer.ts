import type { LogEvent, LogLevel } from 'argus-core'

/** Filtering options for log retrieval. */
export type LogFilters = {
	levels?: LogLevel[]
	grep?: string
	sinceTs?: number
}

type Waiter = {
	after: number
	filters: LogFilters
	limit: number
	resolve: (events: LogEvent[]) => void
	timer: NodeJS.Timeout
}

/** In-memory ring buffer for log events with long-poll waiters. */
export class LogBuffer {
	private readonly maxSize: number
	private events: LogEvent[] = []
	private nextId = 1
	private waiters: Waiter[] = []

	constructor(maxSize: number) {
		this.maxSize = maxSize
	}

	/** Add a log event and return the stored entry with id. */
	add(event: Omit<LogEvent, 'id'>): LogEvent {
		const entry: LogEvent = {
			...event,
			id: this.nextId++
		}
		this.events.push(entry)
		this.trim()
		this.flushWaiters()
		return entry
	}

	/** List events after the given id, respecting filters and limit. */
	listAfter(after: number, filters: LogFilters, limit: number): LogEvent[] {
		const filtered = this.events.filter((event) => event.id > after && matchesFilters(event, filters))
		return filtered.slice(0, limit)
	}

	/** Wait for events after an id or timeout. */
	waitForAfter(after: number, filters: LogFilters, limit: number, timeoutMs: number): Promise<LogEvent[]> {
		const immediate = this.listAfter(after, filters, limit)
		if (immediate.length > 0) {
			return Promise.resolve(immediate)
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer)
				resolve([])
			}, timeoutMs)

			this.waiters.push({ after, filters, limit, resolve, timer })
		})
	}

	/** Get buffer size and id boundaries. */
	getStats(): { size: number; count: number; minId: number | null; maxId: number | null } {
		if (this.events.length === 0) {
			return { size: this.maxSize, count: 0, minId: null, maxId: null }
		}

		return {
			size: this.maxSize,
			count: this.events.length,
			minId: this.events[0]?.id ?? null,
			maxId: this.events[this.events.length - 1]?.id ?? null
		}
	}

	private trim(): void {
		if (this.events.length <= this.maxSize) {
			return
		}

		this.events = this.events.slice(this.events.length - this.maxSize)
	}

	private flushWaiters(): void {
		if (this.waiters.length === 0) {
			return
		}

		const remaining: Waiter[] = []
		for (const waiter of this.waiters) {
			const events = this.listAfter(waiter.after, waiter.filters, waiter.limit)
			if (events.length > 0) {
				clearTimeout(waiter.timer)
				waiter.resolve(events)
				continue
			}
			remaining.push(waiter)
		}
		this.waiters = remaining
	}
}

const matchesFilters = (event: LogEvent, filters: LogFilters): boolean => {
	if (filters.sinceTs && event.ts < filters.sinceTs) {
		return false
	}

	if (filters.levels && filters.levels.length > 0 && !filters.levels.includes(event.level)) {
		return false
	}

	if (filters.grep && !event.text.toLowerCase().includes(filters.grep.toLowerCase())) {
		return false
	}

	return true
}
