import { existsSync } from 'node:fs'
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginContextV1, type ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'

import { resolveArgusConfigPath } from '../../config/loadConfig.js'
import { loadArgusConfigOnce } from '../../config/configContext.js'
import { getGlobalArgusConfigPath } from '../../config/argusHome.js'
import { createOutput } from '../../output/io.js'
import { BUILTIN_PLUGIN_ALIASES, resolvePluginAlias } from './pluginAliases.js'
import { resolvePluginModuleUrl } from './resolvePlugin.js'
import { readPluginManifest } from './pluginManifest.js'
import { formatError } from '../parse.js'

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
			status: 'loaded' | 'deferred'
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

const createLoadedEntry = (entry: PluginInput, plugin: Omit<ArgusPluginV1, 'register'>, url: string): Exclude<PluginLoadEntry, { status: 'failed' }> => ({
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

/**
 * Discover configured plugins once; initialize only manifests selected by `prepare`.
 * Legacy v1 modules lack a registration isolation contract and therefore remain eager.
 */
export const createPluginLoader = async (program: Command, argv: readonly string[] = process.argv.slice(2)): Promise<PluginLoader> => {
	const cwd = process.cwd()

	const globalConfigPath = getGlobalArgusConfigPath()
	const globalConfigResult = existsSync(globalConfigPath) ? loadArgusConfigOnce(globalConfigPath) : null
	const configPath = resolveArgusConfigPath({ cwd })
	const configResult = configPath ? loadArgusConfigOnce(configPath) : null
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

	if (all.length === 0) return { prepare: async () => {} }

	// Preserve original order, but avoid duplicate loads.
	const seen = new Set<string>()
	const ordered = all.filter((p) => {
		const key = p.resolvedSpec.trim()
		if (!key) return false
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	const ctxBase: Omit<ArgusPluginContextV1, 'program' | 'host'> = {
		apiVersion: ARGUS_PLUGIN_API_VERSION,
		cwd,
		configPath: configPath ?? (globalConfigResult ? globalConfigPath : null),
		configDir: configResult?.configDir ?? globalConfigResult?.configDir ?? null,
	}

	const pending: Array<{
		input: PluginInput
		url: string
		eager: boolean
		report: PluginLoadEntry
		loading?: Promise<PluginLoadEntry>
	}> = []
	let host: ArgusPluginContextV1['host'] | undefined
	const load = async (entry: PluginInput, url: string): Promise<PluginLoadEntry> => {
		try {
			const plugin = extractPlugin(await import(url))
			if (!plugin) throw new Error('Invalid plugin export (expected default export with { apiVersion: 1, name, register() }).')
			host ??= (await import('./pluginHost.js')).createPluginHost()
			await plugin.register({ ...ctxBase, host, program })
			return createLoadedEntry(entry, plugin, url)
		} catch (error) {
			const message = formatError(error)
			warnPluginLoad(entry.source, entry.spec, message)
			return { ...entry, status: 'failed', url, error: message }
		}
	}

	for (const entry of ordered) {
		const baseDirs = uniq([entry.configDir, configResult?.configDir, globalConfigResult?.configDir, cwd].filter((v): v is string => Boolean(v)))
		const resolved = resolvePluginModuleUrl(entry.resolvedSpec, baseDirs)
		if (!resolved.ok) {
			recordPluginFailure(entries, entry, resolved.error)
			continue
		}
		const manifest = readPluginManifest(resolved.url)
		const metadata = manifest ?? { apiVersion: ARGUS_PLUGIN_API_VERSION, name: entry.spec, commands: [] }
		const report = { ...createLoadedEntry(entry, metadata, resolved.url), status: 'deferred' as const }
		entries.push(report)
		pending.push({ input: entry, url: resolved.url, eager: manifest?.eager !== false, report })
	}

	return {
		prepare: async (args) => {
			const root = requestedRoot(args) ?? ''
			const known = program.commands.find((command) => command.name() === root || command.aliases().includes(root))
			// Help and explicit listings inspect actual registrations, including dynamically built options.
			const inspectAll = !root || root === 'help' || ((root === 'plugin' || root === 'plugins') && ['list', 'ls'].includes(args[1]))
			const advertised = pending.some(({ report }) => report.status !== 'failed' && report.commands.includes(root))
			const loadAll = inspectAll || (!known && !advertised)
			for (const item of pending) {
				if (item.report.status !== 'deferred') continue
				if (!item.eager && !loadAll && !item.report.commands.includes(root)) continue
				// A timed-out session request can leave registration in flight. Later requests join it.
				item.loading ??= load(item.input, item.url)
				const loaded = await item.loading
				entries[entries.indexOf(item.report)] = loaded
				item.report = loaded
			}
		},
	}
}

export type PluginLoader = {
	/** Prepare registrations for one CLI argv or session command path; already loaded plugins are reused. */
	prepare: (args: readonly string[]) => Promise<void>
}

/** Discover and prepare the plugins used by a one-shot invocation. */
export const registerPlugins = async (program: Command, argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
	const loader = await createPluginLoader(program, argv)
	await loader.prepare(withoutPluginOptions(argv))
}

const withoutPluginOptions = (argv: readonly string[]): string[] => {
	const args: string[] = []
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === '--plugin') {
			index++
			continue
		}
		if (argv[index].startsWith('--plugin=')) continue
		args.push(argv[index])
	}
	return args
}

const requestedRoot = (args: readonly string[]): string | undefined => args[0]?.startsWith('-') ? undefined : args[0]
