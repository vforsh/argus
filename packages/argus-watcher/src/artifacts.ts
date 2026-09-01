import path from 'node:path'
import fs from 'node:fs/promises'

export const ensureArtifactsDir = async (dir: string): Promise<void> => {
	await fs.mkdir(dir, { recursive: true })
}

export const ensureParentDir = async (filePath: string): Promise<void> => {
	const dir = path.dirname(filePath)
	await fs.mkdir(dir, { recursive: true })
}

/**
 * Resolve an artifact output path to an absolute path.
 * - If `outFile` is an absolute path, use it directly (no restriction).
 * - If `outFile` is relative, resolve it under `artifactsDir`.
 * - If `outFile` is empty/undefined, use `defaultName` under `artifactsDir`.
 *
 * The watcher is a separate process whose cwd is unrelated to the caller's, so a relative path
 * can only be resolved against something the watcher owns. Callers that want cwd-relative
 * semantics resolve the path on their side first — the CLI does exactly that for
 * `screenshot`/`record`/`trace` (`resolveArtifactOutFile`), so a relative `--out` lands next to
 * the user rather than in this temp directory.
 */
export const resolveArtifactPath = (artifactsDir: string, outFile: string | undefined, defaultName: string): string => {
	const trimmed = outFile?.trim()

	if (trimmed && path.isAbsolute(trimmed)) {
		return path.resolve(trimmed)
	}

	const baseDir = path.resolve(artifactsDir)
	return path.resolve(baseDir, trimmed || defaultName)
}

/**
 * Move a finished artifact to its final path, falling back to copy+unlink across devices.
 *
 * The temp artifacts dir and a user-supplied `--out` often sit on different filesystems, where
 * `rename` fails with EXDEV. Both recorders re-implemented this fallback verbatim.
 */
export const moveArtifactFile = async (from: string, to: string): Promise<void> => {
	await ensureParentDir(to)
	try {
		await fs.rename(from, to)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
			throw error
		}

		await fs.copyFile(from, to)
		await fs.unlink(from)
	}
}
