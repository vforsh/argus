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
 * Resolve an artifact output path.
 * - If `outFile` is an absolute path, use it directly (no restriction).
 * - If `outFile` is relative, resolve it under `artifactsDir`.
 * - If `outFile` is empty/undefined, use `defaultName` under `artifactsDir`.
 */
export const resolveArtifactPath = (
	artifactsDir: string,
	outFile: string | undefined,
	defaultName: string,
): { absolutePath: string; displayPath: string } => {
	const trimmed = outFile?.trim()

	if (trimmed && path.isAbsolute(trimmed)) {
		const resolved = path.resolve(trimmed)
		return { absolutePath: resolved, displayPath: resolved }
	}

	const baseDir = path.resolve(artifactsDir)
	const fileName = trimmed || defaultName
	const resolved = path.resolve(baseDir, fileName)

	return { absolutePath: resolved, displayPath: resolved }
}
