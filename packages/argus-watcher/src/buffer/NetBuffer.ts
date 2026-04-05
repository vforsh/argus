import type { NetworkRequestDetail, NetworkRequestSummary } from '@vforsh/argus-core'
import { matchesNetFilters, type NetFilters } from '../net/filtering.js'

type StoredNetRecord = {
	summary: NetworkRequestSummary
	detail: NetworkRequestDetail
}

/** In-memory ring buffer for network request summaries plus per-request detail records. */
export class NetBuffer {
	private readonly maxSize: number
	private events: StoredNetRecord[] = []
	private nextId = 1

	constructor(maxSize: number) {
		this.maxSize = maxSize
	}

	/** Add a network summary/detail pair and return the stored detail record with id. */
	add(record: { summary: Omit<NetworkRequestSummary, 'id'>; detail: Omit<NetworkRequestDetail, 'id'> }): NetworkRequestDetail {
		const id = this.nextId++
		const stored: StoredNetRecord = {
			summary: { ...record.summary, id },
			detail: { ...record.detail, id },
		}
		this.events.push(stored)
		this.trim()
		return stored.detail
	}

	/** List events after the given id, respecting filters and limit. */
	listAfter(after: number, filters: NetFilters, limit: number): NetworkRequestSummary[] {
		return this.listMatchingSummaries(limit, (event) => event.summary.id > after && matchesNetFilters(event.summary, filters))
	}

	/** List buffered events without an `after` cursor. */
	list(filters: NetFilters, limit = this.maxSize): NetworkRequestSummary[] {
		return this.listMatchingSummaries(limit, (event) => matchesNetFilters(event.summary, filters))
	}

	/** List detailed request records after the given id, respecting filters and limit. */
	listDetailsAfter(after: number, filters: NetFilters, limit: number): NetworkRequestDetail[] {
		return this.listMatchingDetails(limit, (event) => event.summary.id > after && matchesNetFilters(event.summary, filters))
	}

	/** Retrieve one buffered request by Argus numeric id. */
	getById(id: number): NetworkRequestDetail | null {
		return this.events.find((event) => event.detail.id === id)?.detail ?? null
	}

	/** Retrieve the most recent buffered request by CDP request id. */
	getByRequestId(requestId: string): NetworkRequestDetail | null {
		for (let index = this.events.length - 1; index >= 0; index -= 1) {
			const current = this.events[index]
			if (current?.detail.requestId === requestId) {
				return current.detail
			}
		}
		return null
	}

	/** Get buffer size and id boundaries. */
	getStats(): { size: number; count: number; minId: number | null; maxId: number | null } {
		if (this.events.length === 0) {
			return { size: this.maxSize, count: 0, minId: null, maxId: null }
		}

		return {
			size: this.maxSize,
			count: this.events.length,
			minId: this.events[0]?.summary.id ?? null,
			maxId: this.events[this.events.length - 1]?.summary.id ?? null,
		}
	}

	/** Clear buffered network events and return the number removed. */
	clear(): number {
		const cleared = this.events.length
		this.events = []
		return cleared
	}

	private trim(): void {
		if (this.events.length <= this.maxSize) {
			return
		}
		this.events = this.events.slice(this.events.length - this.maxSize)
	}

	private listMatchingSummaries(limit: number, match: (event: StoredNetRecord) => boolean): NetworkRequestSummary[] {
		return this.events
			.filter(match)
			.slice(0, limit)
			.map((event) => event.summary)
	}

	private listMatchingDetails(limit: number, match: (event: StoredNetRecord) => boolean): NetworkRequestDetail[] {
		return this.events
			.filter(match)
			.slice(0, limit)
			.map((event) => event.detail)
	}
}
