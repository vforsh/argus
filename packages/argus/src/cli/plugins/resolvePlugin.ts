import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { formatError } from '../parse.js'

type ImportMetaWithResolve = ImportMeta & {
	resolve?: (specifier: string, parent?: string) => string
}

const resolveWithImportMeta = (specifier: string, parentUrl: string): string => {
	const resolver = (import.meta as ImportMetaWithResolve).resolve
	if (typeof resolver !== 'function') {
		throw new Error('Runtime does not support import.meta.resolve().')
	}
	return resolver(specifier, parentUrl)
}

const expandHomeSpecifier = (specifier: string): string => {
	if (specifier === '~') return os.homedir()
	if (specifier.startsWith('~/') || specifier.startsWith('~\\')) return path.join(os.homedir(), specifier.slice(2))
	return specifier
}

const isPathLikeSpecifier = (specifier: string): boolean =>
	specifier.startsWith('.') || specifier.startsWith('/') || specifier === '~' || specifier.startsWith('~/') || specifier.startsWith('~\\')

export const resolvePluginModuleUrl = (specifier: string, baseDirs: string[]): { ok: true; url: string } | { ok: false; error: string } => {
	const trimmed = expandHomeSpecifier(specifier.trim())
	if (!trimmed) {
		return { ok: false, error: 'Empty plugin specifier.' }
	}

	if (trimmed.startsWith('file:')) {
		return { ok: true, url: trimmed }
	}

	const errors: string[] = []

	if (isPathLikeSpecifier(trimmed)) {
		for (const baseDir of baseDirs) {
			try {
				const resolvedPath = path.resolve(baseDir, trimmed)
				if (existsSync(resolvedPath)) {
					return { ok: true, url: pathToFileURL(resolvedPath).href }
				}
				errors.push(`${baseDir}: ${resolvedPath} does not exist`)
			} catch (error) {
				const msg = formatError(error)
				errors.push(`${baseDir}: ${msg}`)
			}
		}
		return { ok: false, error: `Failed to resolve plugin path "${specifier}". Tried:\n${errors.map((e) => `- ${e}`).join('\n')}` }
	}

	// 1) Prefer resolving relative to the Argus installation itself.
	// This covers "plugin installed next to argus" (e.g. global install or argus dependency).
	try {
		return { ok: true, url: resolveWithImportMeta(trimmed, import.meta.url) }
	} catch (error) {
		const msg = formatError(error)
		errors.push(`argus: ${msg}`)
	}

	for (const baseDir of baseDirs) {
		try {
			const baseUrl = pathToFileURL(path.join(baseDir, 'noop.js')).href
			return { ok: true, url: resolveWithImportMeta(trimmed, baseUrl) }
		} catch (error) {
			const msg = formatError(error)
			errors.push(`${baseDir}: ${msg}`)
		}
	}

	return { ok: false, error: `Failed to resolve plugin "${specifier}". Tried:\n${errors.map((e) => `- ${e}`).join('\n')}` }
}
