import { assertPluginCompatibility } from './pluginCompatibility.js'
import { registerIndependentPlugin } from './registerIndependentPlugin.js'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ARGUS_PLUGIN_API_VERSION, type ArgusPluginContextV1, type ArgusPluginV1, type ArgusPluginManifestV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'

import { resolveArgusConfigPath } from '../../config/loadConfig.js'
import { loadArgusConfigOnce } from '../../config/configContext.js'
import { getGlobalArgusConfigPath } from '../../config/argusHome.js'
import { createOutput } from '../../output/io.js'
import { BUILTIN_PLUGIN_ALIASES, resolvePluginAlias } from './pluginAliases.js'
import { resolvePluginModuleUrl } from './resolvePlugin.js'
import { inspectPluginManifest, type PluginManifestInspection } from './pluginManifest.js'
import { formatError } from '../parse.js'

type PluginSource = 'global-config' | 'config' | 'env' | 'cli'

type PluginInput = {
	source: PluginSource
	spec: string
	resolvedSpec: string
	alias: string | null
	configDir: string | null
}

export type PluginProvenance = Pick<PluginInput, 'source' | 'spec' | 'resolvedSpec' | 'alias' | 'configDir'>

export type PluginDiscovery = {
	resolvedPath: string | null
	manifestSource: string | null
	manifestStatus: PluginManifestInspection['status']
	compatibility: PluginManifestInspection['compatibility']
	registration: 'eager' | 'deferred' | 'blocked'
	reason: 'absent-manifest' | 'invalid-manifest' | 'explicit-eager' | 'independent-manifest' | 'incompatible-manifest' | 'resolution-failed' | 'name-conflict'
	metadataError?: string
	timings: { resolveMs: number; manifestMs: number; importMs?: number; registerMs?: number }
}

export type PluginLoadEntry =
	| {
			provenance?: PluginProvenance[]
			discovery: PluginDiscovery
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
			provenance?: PluginProvenance[]
			discovery: PluginDiscovery
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
	mode: 'inspection' | 'discovery'
	entries: PluginLoadEntry[]
}

let lastPluginLoadReport: PluginLoadReport = {
	configPath: null,
	configDir: null,
	globalConfigPath: null,
	globalConfigDir: null,
	cwd: process.cwd(),
	mode: 'inspection',
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

const createPluginInput = (
	source: PluginSource,
	spec: string,
	aliases: Record<string, string>,
	configDir: string | null,
	aliasDirs: Record<string, string | null>,
): PluginInput => {
	const resolved = resolvePluginAlias(spec, aliases)
	return {
		source,
		spec,
		resolvedSpec: resolved.spec,
		alias: resolved.alias,
		configDir: resolved.alias && resolved.alias in aliasDirs ? aliasDirs[resolved.alias] : configDir,
	}
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
	assertPluginCompatibility({ apiVersion: plugin.apiVersion, name: plugin.name ?? 'unknown', minArgusVersion: plugin.minArgusVersion })
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

const recordPluginFailure = (entries: PluginLoadEntry[], entry: PluginInput, error: string, discovery: PluginDiscovery, url?: string): void => {
	entries.push({ ...entry, provenance: [entry], discovery, status: 'failed', url, error })
	warnPluginLoad(entry.source, entry.spec, error)
}

const createLoadedEntry = (
	entry: PluginInput,
	plugin: Omit<ArgusPluginV1, 'register'>,
	url: string,
	discovery: PluginDiscovery,
): Exclude<PluginLoadEntry, { status: 'failed' }> => ({
	source: entry.source,
	spec: entry.spec,
	resolvedSpec: entry.resolvedSpec,
	alias: entry.alias,
	discovery,
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

	const globalAliasDirs = Object.fromEntries(
		Object.keys(globalConfigResult?.config.pluginAliases ?? {}).map((name) => [name, globalConfigResult?.configDir ?? null]),
	)
	const localAliasDirs = {
		...globalAliasDirs,
		...Object.fromEntries(Object.keys(configResult?.config.pluginAliases ?? {}).map((name) => [name, configResult?.configDir ?? null])),
	}
	const all: PluginInput[] = []
	for (const spec of globalConfigPlugins)
		all.push(createPluginInput('global-config', spec, globalAliases, globalConfigResult?.configDir ?? null, globalAliasDirs))
	for (const spec of configPlugins) all.push(createPluginInput('config', spec, localAliases, configResult?.configDir ?? null, localAliasDirs))
	for (const spec of envPlugins) all.push(createPluginInput('env', spec, localAliases, null, localAliasDirs))
	for (const spec of cliPlugins) all.push(createPluginInput('cli', spec, localAliases, null, localAliasDirs))

	const entries: PluginLoadEntry[] = []
	lastPluginLoadReport = {
		configPath,
		configDir: configResult?.configDir ?? null,
		globalConfigPath: globalConfigResult ? globalConfigPath : null,
		globalConfigDir: globalConfigResult?.configDir ?? null,
		cwd,
		mode: isDiscoveryRequest(withoutPluginOptions(argv)) ? 'discovery' : 'inspection',
		entries,
	}

	if (all.length === 0) return { prepare: async () => {} }

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
		manifest: ArgusPluginManifestV1 | null
		report: PluginLoadEntry
		loading?: Promise<PluginLoadEntry>
	}> = []
	let host: ArgusPluginContextV1['host'] | undefined
	const claimedNames = new Map<string, string>()
	const claimName = (name: string, url: string): void => {
		const owner = claimedNames.get(name)
		if (owner && owner !== url) throw new Error(`Plugin name "${name}" conflicts between ${owner} and ${url}. Remove or rename one module.`)
		claimedNames.set(name, url)
	}
	const load = async (entry: PluginInput, url: string, manifest: ArgusPluginManifestV1 | null, discovery: PluginDiscovery): Promise<PluginLoadEntry> => {
		try {
			const importStarted = performance.now()
			let mod: unknown
			try {
				mod = await import(url)
			} finally {
				discovery.timings.importMs = performance.now() - importStarted
			}
			const plugin = extractPlugin(mod)
			if (!plugin) throw new Error('Invalid plugin export (expected default export with { apiVersion: 1, name, register() }).')
			claimName(plugin.name, url)
			host ??= (await import('./pluginHost.js')).createPluginHost()
			const ctx = { ...ctxBase, configDir: entry.configDir ?? ctxBase.configDir, host, program }
			const registerStarted = performance.now()
			try {
				if (manifest?.eager === false) await registerIndependentPlugin(plugin, manifest, ctx)
				else await plugin.register(ctx)
			} finally {
				discovery.timings.registerMs = performance.now() - registerStarted
			}
			return createLoadedEntry(entry, plugin, url, discovery)
		} catch (error) {
			const message = formatError(error)
			warnPluginLoad(entry.source, entry.spec, message)
			return { ...entry, discovery, status: 'failed', url, error: message }
		}
	}

	const byUrl = new Map<string, (typeof pending)[number]>()
	for (const entry of all) {
		const resolveStarted = performance.now()
		const resolved = resolvePluginModuleUrl(entry.resolvedSpec, [entry.configDir ?? cwd])
		const resolveMs = performance.now() - resolveStarted
		if (!resolved.ok) {
			recordPluginFailure(entries, entry, resolved.error, {
				resolvedPath: null,
				manifestSource: null,
				manifestStatus: 'absent',
				compatibility: 'unknown',
				registration: 'blocked',
				reason: 'resolution-failed',
				timings: { resolveMs, manifestMs: 0 },
			})
			continue
		}
		const duplicate = byUrl.get(resolved.url)
		if (duplicate) {
			duplicate.report.provenance?.push(entry)
			continue
		}
		const manifestStarted = performance.now()
		const inspection = inspectPluginManifest(resolved.url)
		const manifest = inspection.manifest
		const discovery: PluginDiscovery = {
			resolvedPath: resolved.url.startsWith('file:') ? fileURLToPath(resolved.url) : null,
			manifestSource: inspection.source,
			manifestStatus: inspection.status,
			compatibility: inspection.compatibility,
			registration: manifest?.eager === false ? 'deferred' : 'eager',
			reason: manifestReason(inspection),
			metadataError: inspection.error,
			timings: { resolveMs, manifestMs: performance.now() - manifestStarted },
		}
		try {
			if (inspection.compatibility === 'incompatible') throw new Error(inspection.error)
			if (manifest) claimName(manifest.name, resolved.url)
			const metadata = manifest ?? { apiVersion: ARGUS_PLUGIN_API_VERSION, name: entry.spec, commands: [] }
			const report = { ...createLoadedEntry(entry, metadata, resolved.url, discovery), provenance: [entry], status: 'deferred' as const }
			entries.push(report)
			const item = { input: entry, url: resolved.url, eager: manifest?.eager !== false, manifest, report }
			pending.push(item)
			byUrl.set(resolved.url, item)
		} catch (error) {
			discovery.registration = 'blocked'
			discovery.reason = inspection.compatibility === 'incompatible' ? 'incompatible-manifest' : 'name-conflict'
			recordPluginFailure(entries, entry, formatError(error), discovery, resolved.url)
		}
	}

	return {
		prepare: async (args) => {
			lastPluginLoadReport.mode = isDiscoveryRequest(args) ? 'discovery' : 'inspection'
			if (lastPluginLoadReport.mode === 'discovery') return
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
				item.loading ??= load(item.input, item.url, item.manifest, item.report.discovery)
				const loaded = await item.loading
				loaded.provenance = item.report.provenance
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

const requestedRoot = (args: readonly string[]): string | undefined => (args[0]?.startsWith('-') ? undefined : args[0])

const isDiscoveryRequest = (args: readonly string[]): boolean =>
	['plugin', 'plugins'].includes(args[0]) && ['list', 'ls'].includes(args[1]) && args.includes('--discovery')

const manifestReason = (inspection: PluginManifestInspection): PluginDiscovery['reason'] => {
	if (inspection.status === 'absent') return 'absent-manifest'
	if (inspection.status === 'invalid') return 'invalid-manifest'
	return inspection.manifest?.eager ? 'explicit-eager' : 'independent-manifest'
}
