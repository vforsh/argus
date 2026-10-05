import { DEFAULT_TTL_MS, delay, readRegistry, setWatcherEntry, updateRegistry } from '@vforsh/argus-core'
import type { RegistryV1, WatcherRecord, WatcherReservation } from '@vforsh/argus-core'
import { codedError } from '../errors.js'

/**
 * Registry ownership for one watcher run.
 *
 * Allocation and publication used to be separate unlocked steps, and every write was
 * last-writer-wins: two processes starting together could both take one id, then overwrite each
 * other's heartbeat and delete each other's record on shutdown. Now the id is reserved in the same
 * locked update that picks it, and every later write (publish, heartbeat, release) is gated on the
 * run's `ownerId`. A record held by another live owner is never overwritten or removed.
 */

/**
 * What to do when the requested id is held by another live watcher.
 * - `suffix`: take the first free `<id>-2`, `<id>-3`, … (auto-named watchers such as extension controls).
 * - `error`: fail with `watcher_id_taken` (a name the user chose must mean exactly that name).
 */
export type WatcherIdConflictPolicy = 'suffix' | 'error'

/** A live claim on an id by another run: its published record, or its startup reservation. */
export type WatcherIdHolder = { kind: 'watcher'; record: WatcherRecord } | { kind: 'reservation'; reservation: WatcherReservation }

/**
 * How long an explicitly named id may stay held before failing. Covers the common
 * detach-then-reattach sequence, where the previous holder is still shutting down.
 */
const ID_RELEASE_WAIT_MS = 2_000
const ID_RELEASE_POLL_MS = 100

/**
 * Pick a free watcher id and reserve it for `ownerId` in one locked update.
 * Dead or heartbeat-stale holders are reclaimed; live ones are never displaced.
 * @throws A `watcher_id_taken` coded error under the `error` policy when the id stays held.
 */
export const reserveWatcherId = async (input: { id: string; ownerId: string; onConflict: WatcherIdConflictPolicy }): Promise<string> => {
	const deadline = Date.now() + ID_RELEASE_WAIT_MS

	while (true) {
		// Written from inside the locked updater; an object keeps TS from narrowing it to its initial value.
		const attempt: { claimed: string | null; holder: WatcherIdHolder | null } = { claimed: null, holder: null }
		await updateRegistry((registry) => {
			const now = Date.now()
			for (const candidate of candidateIds(input.id, input.onConflict)) {
				attempt.holder = findLiveHolder(registry, candidate, input.ownerId, now)
				if (attempt.holder) {
					continue
				}
				attempt.claimed = candidate
				return reserve(registry, candidate, input.ownerId, now)
			}
			return registry
		})

		if (attempt.claimed) {
			return attempt.claimed
		}
		if (Date.now() >= deadline && attempt.holder) {
			throw codedError(
				'watcher_id_taken',
				`Watcher id "${input.id}" is already in use (${describeHolder(attempt.holder)}). Stop that watcher or choose another id.`,
			)
		}
		await delay(ID_RELEASE_POLL_MS)
	}
}

/** `error` checks the exact id once per attempt; `suffix` walks `<id>`, `<id>-2`, … until one is free. */
function* candidateIds(id: string, policy: WatcherIdConflictPolicy): Generator<string> {
	yield id
	if (policy === 'error') {
		return
	}
	for (let suffix = 2; ; suffix++) {
		yield `${id}-${suffix}`
	}
}

const reserve = (registry: RegistryV1, id: string, ownerId: string, now: number): RegistryV1 => {
	const watchers = { ...registry.watchers }
	// Only reached when the holder is dead or stale, so dropping its record frees the id.
	delete watchers[id]
	return {
		...registry,
		updatedAt: now,
		watchers,
		reservations: { ...registry.reservations, [id]: { id, pid: process.pid, ownerId, reservedAt: now } },
	}
}

/**
 * Publish or refresh `record` (whose `ownerId` must be set), replacing its reservation.
 * Re-publishes a missing record only while the id is still free.
 * @returns The live holder that blocked the write, or `null` when the record was written.
 */
export const writeOwnedWatcher = async (record: WatcherRecord): Promise<WatcherIdHolder | null> => {
	const attempt: { holder: WatcherIdHolder | null } = { holder: null }
	await updateRegistry((registry) => {
		attempt.holder = findLiveHolder(registry, record.id, record.ownerId, Date.now())
		if (attempt.holder) {
			return registry
		}
		return { ...setWatcherEntry(registry, record), reservations: withoutReservation(registry.reservations, record.id) }
	})
	return attempt.holder
}

/**
 * Publish the watcher's record after startup.
 * @throws A `registration_conflict` coded error when another live owner took the id meanwhile.
 */
export const publishWatcher = async (record: WatcherRecord): Promise<void> => {
	const holder = await writeOwnedWatcher(record)
	if (holder) {
		throw codedError('registration_conflict', `Watcher id "${record.id}" was taken by another process (${describeHolder(holder)}).`)
	}
}

/** Remove this run's record and reservation. Entries owned by anyone else are left alone. */
export const releaseWatcherId = async (id: string, ownerId: string): Promise<void> => {
	await updateRegistry((registry) => {
		const ownsRecord = registry.watchers[id]?.ownerId === ownerId
		const ownsReservation = registry.reservations?.[id]?.ownerId === ownerId
		if (!ownsRecord && !ownsReservation) {
			return registry
		}

		const watchers = { ...registry.watchers }
		if (ownsRecord) {
			delete watchers[id]
		}
		return {
			...registry,
			updatedAt: Date.now(),
			watchers,
			reservations: ownsReservation ? withoutReservation(registry.reservations, id) : registry.reservations,
		}
	})
}

/**
 * Refresh the registry entry until stopped. Never overwrites another owner: when one holds the
 * id, the heartbeat stops and reports it through `onConflict`.
 */
export const startRegistryHeartbeat = (
	getWatcher: () => WatcherRecord,
	intervalMs: number,
	onConflict: (holder: WatcherIdHolder) => void,
): { stop: () => void } => {
	const timer = setInterval(() => {
		const watcher = getWatcher()
		watcher.updatedAt = Date.now()
		writeOwnedWatcher(watcher)
			.then((holder) => {
				if (!holder) {
					return
				}
				clearInterval(timer)
				onConflict(holder)
			})
			.catch((error: unknown) => {
				// Lock contention or a transient FS error; the next tick retries.
				console.error(`[ArgusWatcher] Registry heartbeat failed for ${watcher.id}:`, error)
			})
	}, intervalMs)

	return {
		stop: () => clearInterval(timer),
	}
}

/**
 * Wait up to `timeoutMs` for the id to be free of other live owners (reads without the lock).
 * @returns The holder still present at the deadline, or `null` once the id is free.
 */
export const waitForWatcherIdRelease = async (id: string, timeoutMs = ID_RELEASE_WAIT_MS): Promise<WatcherIdHolder | null> => {
	const deadline = Date.now() + timeoutMs
	while (true) {
		const { registry } = await readRegistry()
		const holder = findLiveHolder(registry, id, undefined, Date.now())
		if (!holder || Date.now() >= deadline) {
			return holder
		}
		await delay(ID_RELEASE_POLL_MS)
	}
}

/** Human summary of who holds an id, for error messages. */
export const describeHolder = (holder: WatcherIdHolder): string =>
	holder.kind === 'watcher'
		? `pid ${holder.record.pid}, ${holder.record.host}:${holder.record.port}${holder.record.ownerId ? '' : ', legacy host'}`
		: `pid ${holder.reservation.pid}, still starting`

/**
 * The live claim on `id` by anyone other than `ownerId`. A record without `ownerId` comes from an
 * older host; it is never ours, even when `ownerId` is undefined.
 */
const findLiveHolder = (registry: RegistryV1, id: string, ownerId: string | undefined, now: number): WatcherIdHolder | null => {
	const isMine = (claimOwner: string | undefined): boolean => ownerId != null && claimOwner === ownerId

	const record = registry.watchers[id]
	if (record && !isMine(record.ownerId) && isClaimLive(record.pid, record.updatedAt, now)) {
		return { kind: 'watcher', record }
	}
	const reservation = registry.reservations?.[id]
	if (reservation && !isMine(reservation.ownerId) && isClaimLive(reservation.pid, reservation.reservedAt, now)) {
		return { kind: 'reservation', reservation }
	}
	return null
}

/** A claim is live while its process exists and it is younger than the registry TTL (what pruning would keep). */
const isClaimLive = (pid: number | undefined, timestamp: number, now: number): boolean =>
	pid != null && now - timestamp <= DEFAULT_TTL_MS && isProcessAlive(pid)

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

const withoutReservation = (reservations: RegistryV1['reservations'], id: string): RegistryV1['reservations'] => {
	if (!reservations?.[id]) {
		return reservations
	}
	const next = { ...reservations }
	delete next[id]
	return Object.keys(next).length > 0 ? next : undefined
}
