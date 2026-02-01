import fs from 'node:fs/promises'
import path from 'node:path'
import { getRegistryPath } from './paths.js'

/** Max time to wait for lock acquisition. */
const LOCK_TIMEOUT_MS = 2_000

/** Lock considered stale if mtime is older than this. */
const STALE_LOCK_MS = 10_000

/** Base delay between retries (ms). Actual delay is randomized. */
const BASE_RETRY_MS = 25

/**
 * Execute `fn` while holding an exclusive lockfile on the registry.
 * Uses `fs.open(path, 'wx')` for atomic creation; retries with jitter
 * if the lock is held; auto-removes stale locks older than 10 s.
 */
export async function withRegistryLock<T>(fn: () => Promise<T>, registryPath = getRegistryPath()): Promise<T> {
	const lockPath = `${registryPath}.lock`
	await fs.mkdir(path.dirname(lockPath), { recursive: true })
	await acquireLock(lockPath)
	try {
		return await fn()
	} finally {
		await releaseLock(lockPath)
	}
}

const acquireLock = async (lockPath: string): Promise<void> => {
	const deadline = Date.now() + LOCK_TIMEOUT_MS
	let attempt = 0

	while (Date.now() < deadline) {
		try {
			const handle = await fs.open(lockPath, 'wx')
			await handle.close()
			return
		} catch (error) {
			if (!isExistError(error)) {
				throw error
			}
		}

		// Lock exists — check for staleness
		if (await removeStaleLock(lockPath)) {
			continue
		}

		attempt += 1
		const jitter = Math.random() * BASE_RETRY_MS
		const delay = Math.min(BASE_RETRY_MS * attempt, 200) + jitter
		await sleep(delay)
	}

	// Last-resort: remove potentially stale lock and try once more
	await removeStaleLock(lockPath)
	try {
		const handle = await fs.open(lockPath, 'wx')
		await handle.close()
		return
	} catch {
		throw new Error(`Failed to acquire registry lock after ${LOCK_TIMEOUT_MS}ms: ${lockPath}`)
	}
}

const releaseLock = async (lockPath: string): Promise<void> => {
	try {
		await fs.unlink(lockPath)
	} catch {
		// Lock already removed (e.g. stale cleanup by another process) — safe to ignore
	}
}

/** Remove lock file if its mtime is older than the staleness threshold. Returns true if removed. */
const removeStaleLock = async (lockPath: string): Promise<boolean> => {
	try {
		const stat = await fs.stat(lockPath)
		if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
			await fs.unlink(lockPath)
			return true
		}
	} catch {
		// Lock gone or inaccessible — either way, retry will handle it
		return true
	}
	return false
}

const isExistError = (error: unknown): boolean => {
	return !!error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
