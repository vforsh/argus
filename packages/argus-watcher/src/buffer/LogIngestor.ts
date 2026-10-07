import type { LogEvent } from '@vforsh/argus-core'
import type { LogEnrichment } from '../cdp/watcherEvents.js'
import type { LogBuffer } from './LogBuffer.js'

const MAX_PENDING_RECORDS = 128
const MAX_WORKERS = 4
const ENRICHMENT_TIMEOUT_MS = 2_000

type Event = Omit<LogEvent, 'id'>
type PendingLog = {
	base: Event
	result?: Event
	finalize: (event: Event) => void
	enrich?: LogEnrichment
	controller: AbortController
	timer?: NodeJS.Timeout
	settled: boolean
	started: boolean
}

/**
 * Append arrival-time records synchronously; commit final records and file output in arrival order.
 * Four workers, at most 128 pending records, 2s per admitted event (including queue time). On pressure
 * finalize the backlog using available results/previews before accepting more work. A cancelled worker
 * remains occupied until its shared fetch/CDP call settles, so pressure cannot increase physical I/O.
 * Navigation and teardown flush before rotating files. Late completions cannot update an issued record.
 */
export class LogIngestor {
	private pending: PendingLog[] = []
	private active = 0
	private closed = false
	private readonly capacity: number

	constructor(private readonly buffer: LogBuffer, private readonly onFinal: (event: Event) => void) {
		this.capacity = Math.max(1, Math.min(MAX_PENDING_RECORDS, buffer.getStats().size))
	}

	/** Admit an event immediately. Enrichment never delays its raw view or allocation of its id. */
	add(base: Event, enrich?: LogEnrichment): void {
		if (this.closed) return
		if (this.pending.length >= this.capacity) this.flush('overloaded')
		const job: PendingLog = {
			base,
			enrich,
			controller: new AbortController(),
			finalize: this.buffer.addPending(base),
			settled: !enrich,
			started: false,
			result: enrich ? undefined : base,
		}
		this.pending.push(job)
		if (enrich) job.timer = setTimeout(() => this.settle(job, { ...base, enrichment: 'timeout' }), ENRICHMENT_TIMEOUT_MS)
		this.drain()
		this.pump()
	}

	/** Finalize the old document before cache invalidation and file rotation; cancel queued work. */
	flush(reason: 'cancelled' | 'overloaded' = 'cancelled'): void {
		for (const job of this.pending) {
			if (job.timer) clearTimeout(job.timer)
			job.controller.abort()
			job.result ??= { ...job.base, enrichment: reason }
			job.settled = true
		}
		this.drain()
	}

	/** Stop accepting events and finalize pending records before closing file output. */
	close(): void {
		this.closed = true
		this.flush()
	}

	private pump(): void {
		for (const job of this.pending) {
			if (this.active >= MAX_WORKERS) return
			if (job.started || job.settled || !job.enrich) continue
			job.started = true
			this.active++
			void job.enrich(job.controller.signal)
				.then((event) => this.settle(job, event), () => this.settle(job, { ...job.base, enrichment: 'failed' }))
				.finally(() => {
					this.active--
					this.pump()
				})
		}
	}

	private settle(job: PendingLog, event: Event): void {
		if (job.settled) return
		job.settled = true
		job.result = event
		if (job.timer) clearTimeout(job.timer)
		job.controller.abort()
		this.drain()
	}

	private drain(): void {
		while (this.pending[0]?.settled) {
			const job = this.pending.shift()!
			const event = job.result ?? job.base
			job.finalize(event)
			this.onFinal(event)
		}
	}
}
