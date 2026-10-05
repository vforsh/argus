import crypto from 'node:crypto'
import path from 'node:path'
import { BIND_TICKET_PREFIX, getArgusHomeDir, readJsonFile, updateJsonFile, type ArgusErrorCode } from '@vforsh/argus-core'

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

export type BindTicket = {
	ticket: string
	/** URL the bound tab is navigated to. */
	destination: string
	createdAt: number
	expiresAt: number
	/** Set once a bind has claimed the ticket. */
	usedAt?: number
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

export type ClaimBindTicketResult = { ok: true; ticket: BindTicket } | { ok: false; code: ArgusErrorCode; error: string }

/**
 * Claim a ticket for one bind attempt, atomically: a second concurrent bind sees it as used.
 * Release it with {@link releaseBindTicket} when the bind fails, so the agent can retry.
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
		const claimed = { ...entry, usedAt: now }
		result = { ok: true, ticket: claimed }
		return { ...tickets, [ticket]: claimed }
	}, now)
	return result
}

/** Undo a claim after a failed bind. A ticket that expired meanwhile stays expired. */
export const releaseBindTicket = async (ticket: string): Promise<void> => {
	await updateTickets((tickets) => {
		const entry = tickets[ticket]
		if (entry?.usedAt == null) {
			return tickets
		}
		const { usedAt: _usedAt, ...released } = entry
		return { ...tickets, [ticket]: released }
	})
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
