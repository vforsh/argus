import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginContextV1, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'

import { resolveArgusConfigPath, loadArgusConfig } from '../../config/argusConfig.js'
import { createOutput } from '../../output/io.js'
import { requestWatcherJson, writeRequestError } from '../../watchers/requestWatcher.js'
import { runChromeOpen } from '../../commands/chrome.js'

type PluginSource = 'config' | 'env'

const parseEnvPlugins = (): string[] => {
	const raw = process.env.ARGUS_PLUGINS
	if (!raw) return []
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

const uniq = (values: string[]): string[] => Array.from(new Set(values))

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

const resolvePluginModuleUrl = (specifier: string, baseDirs: string[]): { ok: true; url: string } | { ok: false; error: string } => {
	const trimmed = specifier.trim()
	if (!trimmed) {
		return { ok: false, error: 'Empty plugin specifier.' }
	}

	if (trimmed.startsWith('file:')) {
		return { ok: true, url: trimmed }
	}

	const errors: string[] = []

	// 1) Prefer resolving relative to the Argus installation itself.
	// This covers "plugin installed next to argus" (e.g. global install or argus dependency).
	try {
		return { ok: true, url: resolveWithImportMeta(trimmed, import.meta.url) }
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		errors.push(`argus: ${msg}`)
	}

	for (const baseDir of baseDirs) {
		try {
			const baseUrl = pathToFileURL(path.join(baseDir, 'noop.js')).href
			return { ok: true, url: resolveWithImportMeta(trimmed, baseUrl) }
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			errors.push(`${baseDir}: ${msg}`)
		}
	}

	return { ok: false, error: `Failed to resolve plugin "${specifier}". Tried:\n${errors.map((e) => `- ${e}`).join('\n')}` }
}

const extractPlugin = (mod: unknown): ArgusPluginV1 | null => {
	if (!mod || typeof mod !== 'object') return null

	const record = mod as Record<string, unknown>
	const candidate = (record.default ?? record.argusPlugin) as unknown
	if (!candidate || typeof candidate !== 'object') return null

	const plugin = candidate as Partial<ArgusPluginV1>
	if (plugin.apiVersion !== ARGUS_PLUGIN_API_VERSION) return null
	if (!plugin.name || typeof plugin.name !== 'string') return null
	if (typeof plugin.register !== 'function') return null

	return plugin as ArgusPluginV1
}

const warnPluginLoad = (source: PluginSource, spec: string, message: string): void => {
	const output = createOutput({ json: false })
	output.writeWarn(`[plugins] Failed to load (${source}) "${spec}": ${message}`)
}

export const registerPlugins = async (program: Command): Promise<void> => {
	const cwd = process.cwd()

	const configPath = resolveArgusConfigPath({ cwd })
	const configResult = configPath ? loadArgusConfig(configPath) : null

	const configPlugins = configResult?.config.plugins ?? []
	const envPlugins = parseEnvPlugins()

	const all: Array<{ source: PluginSource; spec: string }> = []
	for (const spec of configPlugins) all.push({ source: 'config', spec })
	for (const spec of envPlugins) all.push({ source: 'env', spec })

	if (all.length === 0) return

	// Preserve original order, but avoid duplicate loads.
	const seen = new Set<string>()
	const ordered = all.filter((p) => {
		const key = p.spec.trim()
		if (!key) return false
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	const baseDirs = uniq([configResult?.configDir, cwd].filter((v): v is string => Boolean(v)))

	const ctxBase: Omit<ArgusPluginContextV1, 'program'> = {
		apiVersion: ARGUS_PLUGIN_API_VERSION,
		host: { createOutput, requestWatcherJson, writeRequestError, runChromeOpen },
		cwd,
		configPath,
		configDir: configResult?.configDir ?? null,
	}

	for (const entry of ordered) {
		const resolved = resolvePluginModuleUrl(entry.spec, baseDirs)
		if (!resolved.ok) {
			warnPluginLoad(entry.source, entry.spec, resolved.error)
			continue
		}

		let mod: unknown
		try {
			mod = await import(resolved.url)
		} catch (error) {
			warnPluginLoad(entry.source, entry.spec, error instanceof Error ? error.message : String(error))
			continue
		}

		const plugin = extractPlugin(mod)
		if (!plugin) {
			warnPluginLoad(entry.source, entry.spec, 'Invalid plugin export (expected default export with { apiVersion: 1, name, register() }).')
			continue
		}

		try {
			await plugin.register({ ...ctxBase, program })
		} catch (error) {
			warnPluginLoad(entry.source, entry.spec, error instanceof Error ? error.message : String(error))
		}
	}
}
