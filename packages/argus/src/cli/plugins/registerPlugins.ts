import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginContextV1, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'

import { resolveArgusConfigPath, loadArgusConfig } from '../../config/argusConfig.js'
import { createOutput } from '../../output/io.js'
import { requestWatcherJson, writeRequestError } from '../../watchers/requestWatcher.js'
import { runChromeOpen } from '../../commands/chrome.js'

type PluginSource = 'config' | 'env' | 'cli'

type PluginInput = {
	source: PluginSource
	spec: string
}

export type PluginLoadEntry =
	| {
			source: PluginSource
			spec: string
			status: 'loaded'
			name: string
			url: string
	  }
	| {
			source: PluginSource
			spec: string
			status: 'failed'
			error: string
			url?: string
	  }

export type PluginLoadReport = {
	configPath: string | null
	configDir: string | null
	cwd: string
	entries: PluginLoadEntry[]
}

let lastPluginLoadReport: PluginLoadReport = {
	configPath: null,
	configDir: null,
	cwd: process.cwd(),
	entries: [],
}

export const getPluginLoadReport = (): PluginLoadReport => lastPluginLoadReport

const parseEnvPlugins = (): string[] => {
	const raw = process.env.ARGUS_PLUGINS
	if (!raw) return []
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

const uniq = (values: string[]): string[] => Array.from(new Set(values))

/** Plugins must be loaded before Commander parses commands, so scan raw argv for dynamic loads. */
const parseCliPlugins = (argv: readonly string[]): string[] => {
	const plugins: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--plugin') {
			const value = argv[i + 1]
			if (value && !value.startsWith('-')) {
				plugins.push(value)
				i++
			}
			continue
		}
		if (arg.startsWith('--plugin=')) {
			const value = arg.slice('--plugin='.length).trim()
			if (value) plugins.push(value)
		}
	}
	return plugins
}

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

const isPathLikeSpecifier = (specifier: string): boolean => specifier.startsWith('.') || specifier.startsWith('/')

const resolvePluginModuleUrl = (specifier: string, baseDirs: string[]): { ok: true; url: string } | { ok: false; error: string } => {
	const trimmed = specifier.trim()
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
				const msg = error instanceof Error ? error.message : String(error)
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

const recordPluginFailure = (entries: PluginLoadEntry[], entry: PluginInput, error: string, url?: string): void => {
	entries.push({ source: entry.source, spec: entry.spec, status: 'failed', url, error })
	warnPluginLoad(entry.source, entry.spec, error)
}

export const registerPlugins = async (program: Command, argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
	const cwd = process.cwd()

	const configPath = resolveArgusConfigPath({ cwd })
	const configResult = configPath ? loadArgusConfig(configPath) : null

	const configPlugins = configResult?.config.plugins ?? []
	const envPlugins = parseEnvPlugins()
	const cliPlugins = parseCliPlugins(argv)

	const all: PluginInput[] = []
	for (const spec of configPlugins) all.push({ source: 'config', spec })
	for (const spec of envPlugins) all.push({ source: 'env', spec })
	for (const spec of cliPlugins) all.push({ source: 'cli', spec })

	const entries: PluginLoadEntry[] = []
	lastPluginLoadReport = {
		configPath,
		configDir: configResult?.configDir ?? null,
		cwd,
		entries,
	}

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
			recordPluginFailure(entries, entry, resolved.error)
			continue
		}

		let mod: unknown
		try {
			mod = await import(resolved.url)
		} catch (error) {
			recordPluginFailure(entries, entry, error instanceof Error ? error.message : String(error), resolved.url)
			continue
		}

		const plugin = extractPlugin(mod)
		if (!plugin) {
			recordPluginFailure(
				entries,
				entry,
				'Invalid plugin export (expected default export with { apiVersion: 1, name, register() }).',
				resolved.url,
			)
			continue
		}

		try {
			await plugin.register({ ...ctxBase, program })
			entries.push({ source: entry.source, spec: entry.spec, status: 'loaded', name: plugin.name, url: resolved.url })
		} catch (error) {
			recordPluginFailure(entries, entry, error instanceof Error ? error.message : String(error), resolved.url)
		}
	}
}
