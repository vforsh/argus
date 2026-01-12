import path from 'node:path'
import fs from 'node:fs/promises'

export const ensureArtifactsDir = async (dir: string): Promise<void> => {
	await fs.mkdir(dir, { recursive: true })
}

export const resolveArtifactPath = (
	artifactsDir: string,
	outFile: string | undefined,
	defaultName: string,
): { absolutePath: string; displayPath: string } => {
	const baseDir = path.resolve(artifactsDir)
	const fileName = outFile && outFile.trim() ? outFile.trim() : defaultName
	const resolved = path.resolve(baseDir, fileName)

	if (!isPathInside(resolved, baseDir)) {
		throw new Error('outFile must resolve under artifactsDir')
	}

	return { absolutePath: resolved, displayPath: resolved }
}

const isPathInside = (targetPath: string, baseDir: string): boolean => {
	const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`
	return targetPath === baseDir || targetPath.startsWith(normalizedBase)
}
