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
 */
export const resolveArtifactPath = (artifactsDir: string, outFile: string | undefined, defaultName: string): string => {
	const trimmed = outFile?.trim()

	if (trimmed && path.isAbsolute(trimmed)) {
		return path.resolve(trimmed)
	}

	const baseDir = path.resolve(artifactsDir)
	return path.resolve(baseDir, trimmed || defaultName)
}
