import crypto from 'node:crypto'
import path from 'node:path'
import {
	BIND_TICKET_PREFIX,
	getArgusHomeDir,
	readJsonFile,
	updateJsonFile,
	type ArgusErrorCode,
	type ExtensionBrowserTab,
	type WatcherRecord,
} from '@vforsh/argus-core'

/**
 * One-time bind tickets (see `protocol/http/bind.ts` for the flow).
 *
 * Tickets live in a file under Argus home rather than in any watcher, because the tab may open in
 * any browser: `prepare` and `bind` run as separate CLI processes and must agree on ticket state
 * whichever control ends up holding the tab. A ticket is unguessable, short-lived, and single-use;
 * spent and expired entries are kept for a while so a late `bind` can say which one it hit.
 */

/** How long a prepared ticket stays bindable. */
export const BIND_TICKET_TTL_MS = 60_000

/** How long spent/expired tickets are remembered, so their errors stay specific. */
const TOMBSTONE_MS = 10 * 60_000

/** Pinned binding persisted before navigation removes the ticket's URL locator. */
export type BindCheckpoint = {
	control: WatcherRecord
	browserInstanceId: string | null
	tab: ExtensionBrowserTab
	watcher: WatcherRecord
	/** Whether the first attempt reused a watcher rather than creating one. */
	reused: boolean
	/** Set after a successful navigation; retries then skip navigation. */
	navigatedUrl?: string
}

/** Durable single-use ticket, including an exclusive attempt and any resumable side effects. */
export type BindTicket = {
	ticket: string
	/** URL the bound tab is navigated to. */
	destination: string
	createdAt: number
	expiresAt: number
	/** Set only after the entire bind succeeds. */
	usedAt?: number
	/** A live process holds the claim until success/failure; a dead process can be retried before expiry. */
	claim?: { id: string; pid: number }
	checkpoint?: BindCheckpoint
}

type BindTicketsFile = { version: 1; tickets: Record<string, BindTicket> }

const EMPTY: BindTicketsFile = { version: 1, tickets: {} }

const getTicketsPath = (): string => path.join(getArgusHomeDir(), 'bind-tickets.json')

const isTicketsFile = (value: unknown): value is BindTicketsFile =>
	!!value && typeof value === 'object' && (value as BindTicketsFile).version === 1 && typeof (value as BindTicketsFile).tickets === 'object'

/** Create and persist a ticket for `destination`. */
export const createBindTicket = async (destination: string, now = Date.now()): Promise<BindTicket> => {
	const ticket: BindTicket = {
		ticket: `${BIND_TICKET_PREFIX}${crypto.randomBytes(18).toString('base64url')}`,
		destination,
		createdAt: now,
		expiresAt: now + BIND_TICKET_TTL_MS,
	}
	await updateTickets((tickets) => ({ ...tickets, [ticket.ticket]: ticket }), now)
	return ticket
}

/** An exclusive claim token, or a typed single-use/TTL/lookup failure. */
export type ClaimBindTicketResult = { ok: true; ticket: BindTicket; claimId: string } | { ok: false; code: ArgusErrorCode; error: string }

/**
 * Claim a ticket atomically. Concurrent attempts are rejected; dead attempts may resume before TTL.
 * The returned claim id must accompany checkpoint, completion, and release writes.
 */
export const claimBindTicket = async (ticket: string, now = Date.now()): Promise<ClaimBindTicketResult> => {
	let result: ClaimBindTicketResult = {
		ok: false,
		code: 'not_found',
		error: `Unknown bind ticket ${ticket}. Run \`argus ext bind prepare\` first.`,
	}
	await updateTickets((tickets) => {
		const entry = tickets[ticket]
		if (!entry) {
			return tickets
		}
		if (entry.usedAt != null) {
			result = { ok: false, code: 'bind_ticket_used', error: `Bind ticket ${ticket} was already used. Prepare a new one.` }
			return tickets
		}
		if (entry.expiresAt <= now) {
			result = {
				ok: false,
				code: 'bind_ticket_expired',
				error: `Bind ticket ${ticket} expired. Prepare a new one and open its bindUrl sooner.`,
			}
			return tickets
		}
		if (entry.claim && isProcessAlive(entry.claim.pid)) {
			result = {
				ok: false,
				code: 'bind_ticket_used',
				error: `Bind ticket ${ticket} is being bound by another attempt. Retry after it finishes.`,
			}
			return tickets
		}
		const claimed = { ...entry, claim: { id: crypto.randomUUID(), pid: process.pid } }
		result = { ok: true, ticket: claimed, claimId: claimed.claim.id }
		return { ...tickets, [ticket]: claimed }
	}, now)
	return result
}

/** Release only this attempt after failure, retaining its checkpoint. Expiry is never extended. */
export const releaseBindTicket = async (ticket: string, claimId: string): Promise<void> => {
	await updateTickets((tickets) => {
		const entry = tickets[ticket]
		if (entry?.claim?.id !== claimId) {
			return tickets
		}
		const { claim: _claim, ...released } = entry
		return { ...tickets, [ticket]: released }
	})
}

/** Persist the exact binding/stage before losing its URL locator; only the claim holder may write. */
export const checkpointBindTicket = (ticket: string, claimId: string, checkpoint: BindCheckpoint): Promise<void> =>
	updateClaim(ticket, claimId, (entry) => ({ ...entry, checkpoint }))

/** Spend a successfully completed ticket atomically. Later attempts must prepare a new ticket. */
export const completeBindTicket = (ticket: string, claimId: string): Promise<void> =>
	updateClaim(ticket, claimId, (entry) => {
		const { claim: _claim, ...completed } = entry
		return { ...completed, usedAt: Date.now() }
	})

const updateClaim = async (ticket: string, claimId: string, update: (entry: BindTicket) => BindTicket): Promise<void> => {
	await updateTickets((tickets) => {
		const entry = tickets[ticket]
		if (!entry || entry.claim?.id !== claimId || entry.usedAt != null) {
			throw new Error(`Bind ticket ${ticket} is no longer held by this attempt.`)
		}
		return { ...tickets, [ticket]: update(entry) }
	})
}

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** Read the ticket without claiming it (diagnostics and tests). */
export const readBindTicket = async (ticket: string): Promise<BindTicket | null> =>
	(await readJsonFile(getTicketsPath(), EMPTY, isTicketsFile)).tickets[ticket] ?? null

/** Apply `update` and drop tombstones past their retention, in one locked write. */
const updateTickets = async (update: (tickets: Record<string, BindTicket>) => Record<string, BindTicket>, now = Date.now()): Promise<void> => {
	await updateJsonFile(getTicketsPath(), EMPTY, isTicketsFile, (file) => {
		const updated = update(file.tickets)
		const kept = Object.entries(updated).filter(([, entry]) => entry.expiresAt + TOMBSTONE_MS > now)
		if (updated === file.tickets && kept.length === Object.keys(updated).length) {
			return file
		}
		return { ...file, tickets: Object.fromEntries(kept) }
	})
}
