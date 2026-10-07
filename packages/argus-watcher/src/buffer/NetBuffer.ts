import type { NetworkRequestDetail, NetworkRequestSummary } from '@vforsh/argus-core'
import { CircularBuffer } from './CircularBuffer.js'
import { matchesNetFilters, type NetFilters } from '../net/filtering.js'

type StoredNetRecord = {
	summary: NetworkRequestSummary
	detail: NetworkRequestDetail
	bodySessionId: string | null
}

export type NetBufferRecord = StoredNetRecord

/** In-memory ring buffer for network request summaries plus per-request detail records. */
export class NetBuffer {
	private readonly maxSize: number
	private readonly events: CircularBuffer<StoredNetRecord>
	private readonly latestByRequestId = new Map<string, StoredNetRecord>()
	private nextId = 1

	constructor(maxSize: number) {
		this.maxSize = maxSize
		this.events = new CircularBuffer(maxSize)
	}

	/** Add a network summary/detail pair and return the stored detail record with id. */
	add(record: {
		summary: Omit<NetworkRequestSummary, 'id'>
		detail: Omit<NetworkRequestDetail, 'id'>
		/**
		 * Child-session owner for lazy CDP body reads.
		 * Null means the request belongs to the root page session.
		 */
		bodySessionId?: string | null
	}): NetworkRequestDetail {
		const id = this.nextId++
		const stored: StoredNetRecord = {
			summary: { ...record.summary, id },
			detail: { ...record.detail, id },
			bodySessionId: record.bodySessionId ?? null,
		}
		const evicted = this.events.push(stored)
		if (evicted && this.latestByRequestId.get(evicted.detail.requestId) === evicted) {
			this.latestByRequestId.delete(evicted.detail.requestId)
		}
		if (this.events.length > 0) this.latestByRequestId.set(stored.detail.requestId, stored)
		return stored.detail
	}

	/** List events after the given id, respecting filters and limit. */
	listAfter(after: number, filters: NetFilters, limit: number): NetworkRequestSummary[] {
		return this.listMatching(after, filters, limit, (event) => event.summary)
	}

	/** List detailed request records after the given id, respecting filters and limit. */
	listDetailsAfter(after: number, filters: NetFilters, limit: number): NetworkRequestDetail[] {
		return this.listMatching(after, filters, limit, (event) => event.detail)
	}

	/** Retrieve the full stored record by Argus numeric id. */
	getRecordById(id: number): NetBufferRecord | null {
		const firstId = this.events.at(0)?.summary.id ?? this.nextId
		return this.events.at(id - firstId) ?? null
	}

	/** Retrieve the most recent full stored record by CDP request id. */
	getRecordByRequestId(requestId: string): NetBufferRecord | null {
		return this.latestByRequestId.get(requestId) ?? null
	}

	/** Get buffer size and id boundaries. */
	getStats(): { size: number; count: number; minId: number | null; maxId: number | null } {
		if (this.events.length === 0) {
			return { size: this.maxSize, count: 0, minId: null, maxId: null }
		}

		return {
			size: this.maxSize,
			count: this.events.length,
			minId: this.events.at(0)?.summary.id ?? null,
			maxId: this.events.at(this.events.length - 1)?.summary.id ?? null,
		}
	}

	/** Clear buffered network events and indexes, preserving the monotonic id sequence. */
	clear(): number {
		this.latestByRequestId.clear()
		return this.events.clear()
	}

	private listMatching<T>(after: number, filters: NetFilters, limit: number, project: (event: StoredNetRecord) => T): T[] {
		const results: T[] = []
		const firstId = this.events.at(0)?.summary.id ?? this.nextId
		const boundedLimit = limit < 0 ? Infinity : Math.trunc(limit)
		const start = Math.max(0, Math.floor(after) - firstId + 1)
		for (let index = start; index < this.events.length && results.length < boundedLimit; index++) {
			const event = this.events.at(index)!
			if (matchesNetFilters(event.summary, filters)) results.push(project(event))
		}
		return limit < 0 ? results.slice(0, limit) : results
	}
}
