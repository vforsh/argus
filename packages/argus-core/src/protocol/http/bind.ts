/**
 * Exact tab binding through a one-time ticket.
 *
 * An agent that opens a tab through a browser API (Codex's in-app browser, CUA) holds a handle
 * Argus can't see, and the destination URL alone can't tell its tab from other tabs at the same
 * URL. So the agent first opens a waiting page whose URL carries an unguessable ticket — served by
 * any live watcher at `GET /bind?ticket=…` — and `argus ext bind <ticket>` then finds the single tab
 * whose URL contains it, attaches, and navigates it to the real destination.
 */

/** Prefix of every bind ticket; keeps tickets recognizable in tab URLs and logs. */
export const BIND_TICKET_PREFIX = 'argus-bind-'

const BIND_TICKET_PATTERN = /^argus-bind-[A-Za-z0-9_-]{16,64}$/

/**
 * True when `value` has the shape of a bind ticket. Shape only: whether the ticket exists,
 * expired, or was used is the ticket store's concern.
 */
export const isBindTicket = (value: unknown): value is string => typeof value === 'string' && BIND_TICKET_PATTERN.test(value)
