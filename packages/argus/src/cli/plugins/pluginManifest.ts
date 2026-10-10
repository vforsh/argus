import { assertPluginCompatibility } from './pluginCompatibility.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ArgusPluginManifestV1 } from '@vforsh/argus-plugin-api'

export type PluginManifestInspection = {
	status: 'absent' | 'invalid' | 'valid'
	source: string | null
	manifest: ArgusPluginManifestV1 | null
	compatibility: 'unknown' | 'compatible' | 'incompatible'
	error?: string
}

/** Inspect routing metadata without importing plugin code. Sidecars take precedence, including invalid ones. */
export const inspectPluginManifest = (url: string): PluginManifestInspection => {
	let source: string | null = null
	try {
		if (!url.startsWith('file:')) return absentManifest(source)
		const entry = fileURLToPath(url)
		const sidecar = `${entry}.argus-plugin.json`
		let value: unknown
		if (existsSync(sidecar)) {
			source = sidecar
			value = JSON.parse(readFileSync(source, 'utf8'))
		} else {
			for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
				const packagePath = path.join(dir, 'package.json')
				if (existsSync(packagePath)) {
					source = packagePath
					value = JSON.parse(readFileSync(source, 'utf8')).argusPlugin
					if (value === undefined) return absentManifest(source)
					break
				}
				if (path.dirname(dir) === dir) return absentManifest(source)
			}
		}
		const manifest = validateManifest(value)
		if (!manifest) return { status: 'invalid', source, manifest: null, compatibility: 'unknown', error: 'Invalid plugin routing metadata.' }
		try {
			assertPluginCompatibility(manifest)
			return { status: 'valid', source, manifest, compatibility: 'compatible' }
		} catch (error) {
			return { status: 'valid', source, manifest, compatibility: 'incompatible', error: errorMessage(error) }
		}
	} catch (error) {
		return { status: 'invalid', source, manifest: null, compatibility: 'unknown', error: errorMessage(error) }
	}
}

const absentManifest = (source: string | null): PluginManifestInspection => ({ status: 'absent', source, manifest: null, compatibility: 'unknown' })
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const validateManifest = (value: unknown): ArgusPluginManifestV1 | null => {
	if (!value || typeof value !== 'object') return null
	const item = value as Partial<ArgusPluginManifestV1>
	if (typeof item.name !== 'string' || !item.name.trim() || typeof item.eager !== 'boolean') return null
	if (!Array.isArray(item.commands) || !item.commands.every((name) => typeof name === 'string' && /^[^\s-][^\s]*$/.test(name))) return null
	for (const key of ['version', 'description', 'homepage', 'minArgusVersion'] as const) {
		if (item[key] !== undefined && typeof item[key] !== 'string') return null
	}
	return item as ArgusPluginManifestV1
}
