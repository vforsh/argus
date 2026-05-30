import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginContextV1, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'

import { resolveArgusConfigPath, loadArgusConfig } from '../../config/argusConfig.js'
import { getGlobalArgusConfigPath } from '../../config/argusHome.js'
import { createOutput } from '../../output/io.js'
import { BUILTIN_PLUGIN_ALIASES, resolvePluginAlias } from './pluginAliases.js'
import { createPluginHost } from './pluginHost.js'

type PluginSource = 'global-config' | 'config' | 'env' | 'cli'

type PluginInput = {
	source: PluginSource
	spec: string
	resolvedSpec: string
	alias: string | null
	configDir: string | null
}

export type PluginLoadEntry =
	| {
			source: PluginSource
			spec: string
			resolvedSpec: string
			alias: string | null
			status: 'loaded'
			name: string
			version: string | null
			description: string | null
			commands: string[]
			homepage: string | null
			minArgusVersion: string | null
			url: string
	  }
	| {
			source: PluginSource
			spec: string
			resolvedSpec: string
			alias: string | null
			status: 'failed'
			error: string
			url?: string
	  }

export type PluginLoadReport = {
	configPath: string | null
	configDir: string | null
	globalConfigPath: string | null
	globalConfigDir: string | null
	cwd: string
	entries: PluginLoadEntry[]
}

let lastPluginLoadReport: PluginLoadReport = {
	configPath: null,
	configDir: null,
	globalConfigPath: null,
	globalConfigDir: null,
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

const createPluginInput = (source: PluginSource, spec: string, aliases: Record<string, string>, configDir: string | null): PluginInput => {
	const resolved = resolvePluginAlias(spec, aliases)
	return { source, spec, resolvedSpec: resolved.spec, alias: resolved.alias, configDir }
}

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

const expandHomeSpecifier = (specifier: string): string => {
	if (specifier === '~') return os.homedir()
	if (specifier.startsWith('~/') || specifier.startsWith('~\\')) return path.join(os.homedir(), specifier.slice(2))
	return specifier
}

const isPathLikeSpecifier = (specifier: string): boolean =>
	specifier.startsWith('.') || specifier.startsWith('/') || specifier === '~' || specifier.startsWith('~/') || specifier.startsWith('~\\')

const resolvePluginModuleUrl = (specifier: string, baseDirs: string[]): { ok: true; url: string } | { ok: false; error: string } => {
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

const normalizeOptionalString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const normalizeCommands = (value: unknown): string[] => {
	if (!Array.isArray(value)) return []
	const commands = value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter(Boolean)
	return Array.from(new Set(commands))
}

const warnPluginLoad = (source: PluginSource, spec: string, message: string): void => {
	const output = createOutput({ json: false })
	output.writeWarn(`[plugins] Failed to load (${source}) "${spec}": ${message}`)
}

const recordPluginFailure = (entries: PluginLoadEntry[], entry: PluginInput, error: string, url?: string): void => {
	entries.push({ source: entry.source, spec: entry.spec, resolvedSpec: entry.resolvedSpec, alias: entry.alias, status: 'failed', url, error })
	warnPluginLoad(entry.source, entry.spec, error)
}

const createLoadedEntry = (entry: PluginInput, plugin: ArgusPluginV1, url: string): PluginLoadEntry => ({
	source: entry.source,
	spec: entry.spec,
	resolvedSpec: entry.resolvedSpec,
	alias: entry.alias,
	status: 'loaded',
	name: plugin.name,
	version: normalizeOptionalString(plugin.version),
	description: normalizeOptionalString(plugin.description),
	commands: normalizeCommands(plugin.commands),
	homepage: normalizeOptionalString(plugin.homepage),
	minArgusVersion: normalizeOptionalString(plugin.minArgusVersion),
	url,
})

export const registerPlugins = async (program: Command, argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
	const cwd = process.cwd()

	const globalConfigPath = getGlobalArgusConfigPath()
	const globalConfigResult = existsSync(globalConfigPath) ? loadArgusConfig(globalConfigPath) : null
	const configPath = resolveArgusConfigPath({ cwd })
	const configResult = configPath ? loadArgusConfig(configPath) : null
	const globalAliases = { ...BUILTIN_PLUGIN_ALIASES, ...(globalConfigResult?.config.pluginAliases ?? {}) }
	const localAliases = { ...globalAliases, ...(configResult?.config.pluginAliases ?? {}) }

	const globalConfigPlugins = globalConfigResult?.config.plugins ?? []
	const configPlugins = configResult?.config.plugins ?? []
	const envPlugins = parseEnvPlugins()
	const cliPlugins = parseCliPlugins(argv)

	const all: PluginInput[] = []
	for (const spec of globalConfigPlugins) all.push(createPluginInput('global-config', spec, globalAliases, globalConfigResult?.configDir ?? null))
	for (const spec of configPlugins) all.push(createPluginInput('config', spec, localAliases, configResult?.configDir ?? null))
	for (const spec of envPlugins) all.push(createPluginInput('env', spec, localAliases, null))
	for (const spec of cliPlugins) all.push(createPluginInput('cli', spec, localAliases, null))

	const entries: PluginLoadEntry[] = []
	lastPluginLoadReport = {
		configPath,
		configDir: configResult?.configDir ?? null,
		globalConfigPath: globalConfigResult ? globalConfigPath : null,
		globalConfigDir: globalConfigResult?.configDir ?? null,
		cwd,
		entries,
	}

	if (all.length === 0) return

	// Preserve original order, but avoid duplicate loads.
	const seen = new Set<string>()
	const ordered = all.filter((p) => {
		const key = p.resolvedSpec.trim()
		if (!key) return false
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	const ctxBase: Omit<ArgusPluginContextV1, 'program'> = {
		apiVersion: ARGUS_PLUGIN_API_VERSION,
		host: createPluginHost(),
		cwd,
		configPath: configPath ?? (globalConfigResult ? globalConfigPath : null),
		configDir: configResult?.configDir ?? globalConfigResult?.configDir ?? null,
	}

	for (const entry of ordered) {
		const baseDirs = uniq([entry.configDir, configResult?.configDir, globalConfigResult?.configDir, cwd].filter((v): v is string => Boolean(v)))
		const resolved = resolvePluginModuleUrl(entry.resolvedSpec, baseDirs)
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
			entries.push(createLoadedEntry(entry, plugin, resolved.url))
		} catch (error) {
			recordPluginFailure(entries, entry, error instanceof Error ? error.message : String(error), resolved.url)
		}
	}
}
