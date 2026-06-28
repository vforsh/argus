import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOutput } from '../../output/io.js'

export type ExtensionPathOptions = {
	json?: boolean
}

/**
 * Print the absolute path to the unpacked Argus extension to load via
 * chrome://extensions ("Load unpacked"). The built extension ships inside the
 * CLI package (`dist/extension`), so end users never run a build step.
 */
export const runExtensionPath = (options: ExtensionPathOptions): void => {
	const output = createOutput(options)
	const extensionDir = resolveExtensionDir()

	if (!extensionDir) {
		const message = `Packaged Argus extension not found. Checked:\n${resolveExtensionCandidates().join('\n')}`
		if (options.json) {
			output.writeJson({ ok: false, error: { message } })
		} else {
			console.error(message)
		}
		process.exitCode = 2
		return
	}

	if (options.json) {
		output.writeJson({ ok: true, path: extensionDir })
		return
	}

	output.writeHuman(extensionDir)
}

/**
 * Resolve the directory of the loadable unpacked extension, or `null` if no
 * candidate contains both a manifest and a built service worker.
 */
export const resolveExtensionDir = (): string | null => {
	for (const candidate of resolveExtensionCandidates()) {
		if (isLoadableExtensionDir(candidate)) {
			return candidate
		}
	}
	return null
}

const isLoadableExtensionDir = (dir: string): boolean => {
	return fs.existsSync(path.join(dir, 'manifest.json')) && fs.existsSync(path.join(dir, 'dist', 'background', 'service-worker.js'))
}

/**
 * Candidate locations, covering the bundled CLI (`<dist>/extension`), the
 * tsc-only build (`<dist>/commands/extension` -> `<dist>/extension`), and the
 * dev source tree (`packages/argus-extension`).
 */
const resolveExtensionCandidates = (): string[] => {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url))
	const candidates = [
		path.resolve(moduleDir, 'extension'),
		path.resolve(moduleDir, '..', '..', 'extension'),
		path.resolve(moduleDir, '..', 'extension'),
		path.resolve(moduleDir, '..', '..', '..', 'argus-extension'),
		path.resolve(moduleDir, '..', '..', '..', '..', 'argus-extension'),
	]
	return [...new Set(candidates)]
}
