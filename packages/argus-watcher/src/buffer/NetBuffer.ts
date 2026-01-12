import type { NetworkRequestSummary } from '@vforsh/argus-core'

export type NetFilters = {
	grep?: string
	sinceTs?: number
}

type Waiter = {
	after: number
	filters: NetFilters
	limit: number
	resolve: (events: NetworkRequestSummary[]) => void
	timer: NodeJS.Timeout
}

/** In-memory ring buffer for network request summaries with long-poll waiters. */
export class NetBuffer {
	private readonly maxSize: number
	private events: NetworkRequestSummary[] = []
	private nextId = 1
	private waiters: Waiter[] = []

	constructor(maxSize: number) {
		this.maxSize = maxSize
	}

	/** Add a network summary and return the stored entry with id. */
	add(event: Omit<NetworkRequestSummary, 'id'>): NetworkRequestSummary {
		const entry: NetworkRequestSummary = { ...event, id: this.nextId++ }
		this.events.push(entry)
		this.trim()
		this.flushWaiters()
		return entry
	}

	/** List events after the given id, respecting filters and limit. */
	listAfter(after: number, filters: NetFilters, limit: number): NetworkRequestSummary[] {
		const filtered = this.events.filter((event) => event.id > after && matchesFilters(event, filters))
		return filtered.slice(0, limit)
	}

	/** Wait for events after an id or timeout. */
	waitForAfter(after: number, filters: NetFilters, limit: number, timeoutMs: number): Promise<NetworkRequestSummary[]> {
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
			maxId: this.events[this.events.length - 1]?.id ?? null,
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

const matchesFilters = (event: NetworkRequestSummary, filters: NetFilters): boolean => {
	if (filters.sinceTs && event.ts < filters.sinceTs) {
		return false
	}

	if (filters.grep) {
		const haystack = event.url.toLowerCase()
		const needle = filters.grep.toLowerCase()
		if (!haystack.includes(needle)) {
			return false
		}
	}

	return true
}
