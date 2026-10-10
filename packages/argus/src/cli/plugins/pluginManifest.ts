import { assertPluginCompatibility } from './pluginCompatibility.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ArgusPluginManifestV1 } from '@vforsh/argus-plugin-api'

/**
 * Read routing metadata without executing a plugin. No persistent cache: edits, installs,
 * symlink replacements, and config changes take effect on the next CLI invocation.
 * Invalid metadata falls back to the original v1 loader, never hides an existing command.
 */
export const readPluginManifest = (url: string): ArgusPluginManifestV1 | null => {
	if (!url.startsWith('file:')) return null
	try {
		const entry = fileURLToPath(url)
		const sidecar = `${entry}.argus-plugin.json`
		if (existsSync(sidecar)) return validateManifest(JSON.parse(readFileSync(sidecar, 'utf8')))
		for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
			const packagePath = path.join(dir, 'package.json')
			if (existsSync(packagePath)) {
				return validateManifest(JSON.parse(readFileSync(packagePath, 'utf8')).argusPlugin)
			}
			if (path.dirname(dir) === dir) return null
		}
	} catch (error) {
		if (error instanceof PluginManifestCompatibilityError) throw error
		return null
	}
}

const validateManifest = (value: unknown): ArgusPluginManifestV1 | null => {
	if (!value || typeof value !== 'object') return null
	const item = value as Partial<ArgusPluginManifestV1>
	if (typeof item.name !== 'string' || !item.name.trim() || typeof item.eager !== 'boolean') return null
	if (!Array.isArray(item.commands) || !item.commands.every((name) => typeof name === 'string' && /^[^\s-][^\s]*$/.test(name))) return null
	for (const key of ['version', 'description', 'homepage', 'minArgusVersion'] as const) {
		if (item[key] !== undefined && typeof item[key] !== 'string') return null
	}
	try {
		assertPluginCompatibility({ apiVersion: item.apiVersion, name: item.name, minArgusVersion: item.minArgusVersion })
	} catch (error) {
		throw new PluginManifestCompatibilityError(error instanceof Error ? error.message : String(error))
	}
	return item as ArgusPluginManifestV1
}

class PluginManifestCompatibilityError extends Error {}
