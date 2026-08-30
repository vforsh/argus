import { randomUUID } from 'node:crypto'
import type { LogEpoch, LogEvent, LogLevel } from '@vforsh/argus-core'

/**
 * Filtering options for log retrieval.
 *
 * Used by `LogBuffer.listAfterEpoch()` and `LogBuffer.waitForAfterEpoch()`.
 */
export type LogFilters = {
	/** If provided, only include events whose `level` is in this list. */
	levels?: LogLevel[]

	/**
	 * Match event text against any of these regex patterns.
	 * If provided, only include events that match at least one pattern.
	 */
	match?: RegExp[]

	/**
	 * Case-insensitive substring match against `LogEvent.source`.
	 * If provided, only include events whose source contains this value.
	 */
	source?: string

	/**
	 * Only include events with `event.ts >= sinceTs`.
	 *
	 * Timestamp is **epoch milliseconds** (same units as `Date.now()`).
	 */
	sinceTs?: number
}

type EpochWaiter = {
	position: number
	filters: LogFilters
	limit: number
	resolve: (result: LogEpochQueryResult) => void
	reject: (error: LogEpochError) => void
	timer: NodeJS.Timeout
}

/** Error raised when an opaque log epoch cannot be used for this buffer. */
export class LogEpochError extends Error {
	readonly code: 'invalid' | 'mismatch' | 'future' | 'evicted'

	constructor(code: LogEpochError['code'], message: string) {
		super(message)
		this.name = 'LogEpochError'
		this.code = code
	}
}

/** Result of a bounded query made from an opaque log epoch. */
export type LogEpochQueryResult = {
	events: LogEvent[]
	nextCursor: LogEpoch
}

type EpochPayload = {
	v: 1
	s: string
	p: number
}

const EPOCH_PREFIX = 'argus-log-epoch-v1.'

/** In-memory ring buffer for log events with long-poll waiters. */
export class LogBuffer {
	private readonly maxSize: number
	private readonly streamId = randomUUID()
	private events: LogEvent[] = []
	private nextId = 1
	private epochWaiters: EpochWaiter[] = []

	constructor(maxSize: number) {
		this.maxSize = maxSize
	}

	/** Add a log event and return the stored entry with id. */
	add(event: Omit<LogEvent, 'id'>): LogEvent {
		const entry: LogEvent = {
			...event,
			id: this.nextId++,
		}
		this.events.push(entry)
		this.trim()
		this.flushEpochWaiters()
		return entry
	}

	/** List events after the given id, respecting filters and limit. */
	listAfter(after: number, filters: LogFilters, limit: number): LogEvent[] {
		return this.listAfterPosition(after, filters, limit)
	}

	/**
	 * Return an opaque position in this watcher's current log stream, at the current append point.
	 *
	 * A query started from it sees only what arrives next. Three methods used to return this exact
	 * value under three names (`getCursor`, `beginLogEpoch`, `getEpoch`).
	 */
	beginLogEpoch(): LogEpoch {
		return encodeEpoch({ v: 1, s: this.streamId, p: this.currentPosition() })
	}

	/**
	 * Return the oldest position this buffer can still serve.
	 *
	 * "Give me everything you have" is this epoch, which is what lets the whole-buffer query use the
	 * same path as a cursored one instead of a parallel id-based long-poll subsystem.
	 */
	epochAtStart(): LogEpoch {
		const oldest = this.events[0]
		return this.getEpochAt(oldest ? oldest.id - 1 : this.currentPosition())
	}

	/** Encode a known stream position for response pagination. */
	getEpochAt(position: number): LogEpoch {
		return encodeEpoch({ v: 1, s: this.streamId, p: position })
	}

	/** List events after an epoch, failing instead of silently returning a partial delta. */
	listAfterEpoch(epoch: LogEpoch, filters: LogFilters, limit: number): LogEpochQueryResult {
		const position = this.resolveEpoch(epoch)
		const events = this.listAfterPosition(position, filters, limit)
		return {
			events,
			nextCursor: events.length > 0 ? this.getEpochAt(events[events.length - 1]?.id ?? position) : epoch,
		}
	}

	/** Wait for events after an epoch, rejecting if the marker becomes stale while waiting. */
	async waitForAfterEpoch(epoch: LogEpoch, filters: LogFilters, limit: number, timeoutMs: number): Promise<LogEpochQueryResult> {
		const position = this.resolveEpoch(epoch)
		const immediate = this.listAfterPosition(position, filters, limit)
		if (immediate.length > 0) {
			return { events: immediate, nextCursor: this.getEpochAt(immediate[immediate.length - 1]?.id ?? position) }
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.epochWaiters = this.epochWaiters.filter((waiter) => waiter.timer !== timer)
				resolve({ events: [], nextCursor: epoch })
			}, timeoutMs)

			this.epochWaiters.push({ position, filters, limit, resolve, reject, timer })
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
		if (this.maxSize <= 0) {
			this.events = []
			return
		}
		if (this.events.length <= this.maxSize) {
			return
		}

		this.events = this.events.slice(this.events.length - this.maxSize)
	}

	private flushEpochWaiters(): void {
		if (this.epochWaiters.length === 0) {
			return
		}

		const remaining: EpochWaiter[] = []
		for (const waiter of this.epochWaiters) {
			try {
				this.validatePosition(waiter.position)
			} catch (error) {
				clearTimeout(waiter.timer)
				waiter.reject(error as LogEpochError)
				continue
			}

			const events = this.listAfterPosition(waiter.position, waiter.filters, waiter.limit)
			if (events.length > 0) {
				clearTimeout(waiter.timer)
				waiter.resolve({
					events,
					nextCursor: this.getEpochAt(events[events.length - 1]?.id ?? waiter.position),
				})
				continue
			}
			remaining.push(waiter)
		}
		this.epochWaiters = remaining
	}

	private listAfterPosition(position: number, filters: LogFilters, limit: number): LogEvent[] {
		return this.events.filter((event) => event.id > position && matchesFilters(event, filters)).slice(0, limit)
	}

	private resolveEpoch(epoch: LogEpoch): number {
		const payload = decodeEpoch(epoch)
		if (!payload) {
			throw new LogEpochError('invalid', 'Invalid log epoch. Capture a new epoch from the watcher.')
		}
		if (payload.s !== this.streamId) {
			throw new LogEpochError('mismatch', 'Log epoch belongs to a different watcher session. Capture a new epoch.')
		}
		if (payload.p > this.currentPosition()) {
			throw new LogEpochError('future', 'Log epoch points past the current log stream.')
		}

		this.validatePosition(payload.p)
		return payload.p
	}

	private validatePosition(position: number): void {
		if (this.events.length > 0 && position < (this.events[0]?.id ?? position + 1) - 1) {
			throw new LogEpochError('evicted', 'Log epoch is stale because the ring buffer evicted entries. Capture a new epoch.')
		}
		if (this.maxSize === 0 && this.currentPosition() > position) {
			throw new LogEpochError('evicted', 'Log epoch is stale because the ring buffer evicted entries. Capture a new epoch.')
		}
	}

	private currentPosition(): number {
		return this.nextId - 1
	}
}

const encodeEpoch = (payload: EpochPayload): LogEpoch => `${EPOCH_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`

const decodeEpoch = (epoch: LogEpoch): EpochPayload | null => {
	if (typeof epoch !== 'string' || !epoch.startsWith(EPOCH_PREFIX)) {
		return null
	}

	try {
		const parsed = JSON.parse(Buffer.from(epoch.slice(EPOCH_PREFIX.length), 'base64url').toString('utf8')) as Partial<EpochPayload>
		if (
			parsed.v !== 1 ||
			typeof parsed.s !== 'string' ||
			!parsed.s ||
			typeof parsed.p !== 'number' ||
			!Number.isSafeInteger(parsed.p) ||
			parsed.p < 0
		) {
			return null
		}
		return parsed as EpochPayload
	} catch {
		return null
	}
}

const matchesFilters = (event: LogEvent, filters: LogFilters): boolean => {
	if (filters.sinceTs && event.ts < filters.sinceTs) {
		return false
	}

	if (filters.levels && filters.levels.length > 0 && !filters.levels.includes(event.level)) {
		return false
	}

	if (filters.source && !event.source.toLowerCase().includes(filters.source.toLowerCase())) {
		return false
	}

	if (filters.match && filters.match.length > 0) {
		for (const pattern of filters.match) {
			if (pattern.test(event.text)) {
				return true
			}
		}
		return false
	}

	return true
}
