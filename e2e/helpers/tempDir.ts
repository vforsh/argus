import { afterEach } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Create `<tmpdir>/<prefix>-XXXXXX`. */
export const makeTempDir = (prefix: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))

/** Remove a temp dir; a no-op for a suite whose setup failed before creating it. */
export const removeDir = async (dir: string | undefined): Promise<void> => {
	if (dir) await fs.rm(dir, { recursive: true, force: true })
}

/** Run `fn` in a fresh temp dir that is removed afterwards, pass or fail. */
export const withTempDir = async <T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> => {
	const dir = await makeTempDir(prefix)
	try {
		return await fn(dir)
	} finally {
		await removeDir(dir)
	}
}

/** Returns a temp-dir factory whose dirs are removed after each test. Call at file or describe scope. */
export const useTempDirs = (prefix: string): (() => Promise<string>) => {
	const dirs: string[] = []
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(removeDir))
	})
	return async () => {
		const dir = await makeTempDir(prefix)
		dirs.push(dir)
		return dir
	}
}
