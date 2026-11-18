import { execFile } from 'node:child_process'
import { isProcessAlive, type WatcherAutoStopReason } from '@vforsh/argus-core'
import type { WatcherLifecycleOptions } from '../index.js'

const OWNER_POLL_MS = 2_000
/** setTimeout fires almost immediately past 2^31-1 ms (~24.8 days), so long deadlines are re-armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1

export type LifecycleGuard = {
	/** Mark a client request in flight; the idle clock stays paused until the returned callback runs. */
	trackRequest: () => () => void
	stop: () => void
}

/**
 * Enforce owner-pid, idle and TTL limits by calling `onExpire` once with the first reason that fires.
 * Timers are unref'd: they bound the watcher's life but never keep the process alive themselves.
 */
export const startLifecycleGuard = (lifecycle: WatcherLifecycleOptions | undefined, onExpire: (reason: WatcherAutoStopReason) => void): LifecycleGuard => {
	const timers = new Map<string, NodeJS.Timeout>()
	let inFlight = 0
	let fired = false

	const schedule = (name: string, deadline: number, reason: WatcherAutoStopReason) => {
		const timer = setTimeout(() => {
			if (Date.now() >= deadline) expire(reason)
			else schedule(name, deadline, reason)
		}, Math.min(Math.max(deadline - Date.now(), 0), MAX_TIMER_MS))
		timer.unref()
		timers.set(name, timer)
	}
	const clear = (name: string) => {
		clearTimeout(timers.get(name))
		timers.delete(name)
	}
	const stop = () => {
		fired = true
		for (const name of [...timers.keys()]) clear(name)
	}
	const expire = (reason: WatcherAutoStopReason) => {
		if (fired) return
		stop()
		onExpire(reason)
	}

	const { ownerPid, idleExitMs, ttlMs } = lifecycle ?? {}
	if (ownerPid !== undefined) {
		const identity = readProcessIdentity(ownerPid)
		const poll = async () => {
			if (fired) return
			if (!(await isSameProcessAlive(ownerPid, await identity))) return expire('owner_exited')
			const timer = setTimeout(() => void poll(), OWNER_POLL_MS)
			timer.unref()
			timers.set('owner', timer)
		}
		void poll()
	}
	if (ttlMs !== undefined) schedule('ttl', Date.now() + ttlMs, 'ttl')

	const armIdle = () => {
		if (idleExitMs === undefined || fired) return
		clear('idle')
		if (inFlight === 0) schedule('idle', Date.now() + idleExitMs, 'idle')
	}
	armIdle()

	const trackRequest = () => {
		inFlight += 1
		armIdle()
		let done = false
		return () => {
			if (done) return
			done = true
			inFlight -= 1
			armIdle()
		}
	}

	return { trackRequest, stop }
}

/** Process start time as `ps` prints it; null where `ps` is unavailable (Windows) or the pid is gone. */
type ProcessIdentity = { startedAt: string; zombie: boolean } | null

const readProcessIdentity = (pid: number): Promise<ProcessIdentity> =>
	new Promise((resolve) => {
		if (process.platform === 'win32') return resolve(null)
		execFile('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout) => {
			const match = error ? null : stdout.trim().match(/^(\S+)\s+(.+)$/)
			resolve(match ? { zombie: match[1].startsWith('Z'), startedAt: match[2] } : null)
		})
	})

/**
 * `kill(pid, 0)` alone is fooled twice: a SIGKILLed owner its parent never reaped stays a signalable
 * zombie, and a reused pid belongs to a different process. `ps` stat/start time catches both.
 */
const isSameProcessAlive = async (pid: number, original: ProcessIdentity): Promise<boolean> => {
	if (!isProcessAlive(pid)) return false
	if (!original) return true
	const current = await readProcessIdentity(pid)
	return current !== null && !current.zombie && current.startedAt === original.startedAt
}
