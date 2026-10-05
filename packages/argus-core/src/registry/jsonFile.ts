import fs from 'node:fs/promises'
import path from 'node:path'
import { withRegistryLock } from './lock.js'

/**
 * Small JSON state files under Argus home (registry, bind tickets, browser labels), shared by
 * concurrent CLI and watcher processes: writes go through a lockfile and an atomic rename, so a
 * reader never sees a half-written file and two writers never lose each other's update.
 */

/**
 * Read and parse a JSON file. A missing or unparseable file yields `fallback`: these files are
 * caches of short-lived state, and a corrupt one must not wedge every command.
 */
export const readJsonFile = async <T>(filePath: string, fallback: T, isValid: (value: unknown) => value is T): Promise<T> => {
	let raw: string
	try {
		raw = await fs.readFile(filePath, 'utf8')
	} catch (error) {
		if (isMissingFileError(error)) {
			return fallback
		}
		throw error
	}
	try {
		const parsed: unknown = JSON.parse(raw)
		return isValid(parsed) ? parsed : fallback
	} catch {
		return fallback
	}
}

/**
 * Locked read-modify-write of a JSON file. Return the input unchanged to skip the write.
 * @returns The state after the update.
 */
export const updateJsonFile = async <T>(
	filePath: string,
	fallback: T,
	isValid: (value: unknown) => value is T,
	updater: (current: T) => T,
): Promise<T> =>
	withRegistryLock(async () => {
		const current = await readJsonFile(filePath, fallback, isValid)
		const next = updater(current)
		if (next !== current) {
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await atomicWriteFile(filePath, JSON.stringify(next, null, 2))
		}
		return next
	}, filePath)

/** Replace `filePath` with `contents` via a temp file + rename. */
export const atomicWriteFile = async (filePath: string, contents: string): Promise<void> => {
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
	await fs.writeFile(tmpPath, contents, 'utf8')

	try {
		await fs.rename(tmpPath, filePath)
	} catch (error) {
		if (!isReplaceError(error)) {
			throw error
		}
		await fs.rm(filePath, { force: true })
		await fs.rename(tmpPath, filePath)
	}
}

const isReplaceError = (error: unknown): error is NodeJS.ErrnoException => {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return false
	}

	const err = error as NodeJS.ErrnoException
	return err.code === 'EEXIST' || err.code === 'EPERM'
}

/** True for Node's "no such file" error. */
export const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException => {
	if (!error || typeof error !== 'object' || !('code' in error)) {
		return false
	}

	const err = error as NodeJS.ErrnoException
	return err.code === 'ENOENT'
}
