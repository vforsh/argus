import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createOutput } from '../output/io.js'
import { resolveArgusConfigPath } from '../config/argusConfig.js'
import { getGlobalArgusConfigPath } from '../config/argusHome.js'
import { BUILTIN_PLUGIN_ALIASES, resolvePluginAlias } from '../cli/plugins/pluginAliases.js'

export type PluginConfigMutationOptions = {
	path?: string
	global?: boolean
	json?: boolean
}

type JsonObject = Record<string, unknown>

type MutablePluginConfig = {
	path: string
	config: JsonObject
	plugins: string[]
	pluginAliases: Record<string, string>
}

const DEFAULT_CONFIG_PATH = '.argus/config.json'

const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

const resolveTargetConfigPath = (cwd: string, cliPath?: string): { path: string; exists: boolean } | null => {
	if (cliPath) {
		const resolved = path.isAbsolute(cliPath) ? cliPath : path.resolve(cwd, cliPath)
		return { path: resolved, exists: existsSync(resolved) }
	}

	const discovered = resolveArgusConfigPath({ cwd })
	if (discovered) return { path: discovered, exists: true }
	if (process.exitCode) return null

	return { path: path.resolve(cwd, DEFAULT_CONFIG_PATH), exists: false }
}

const resolveGlobalTargetConfigPath = (): { path: string; exists: boolean } => {
	const configPath = getGlobalArgusConfigPath()
	return { path: configPath, exists: existsSync(configPath) }
}

const readConfigObject = async (configPath: string, exists: boolean): Promise<JsonObject | null> => {
	if (!exists) return {}

	let raw: string
	try {
		raw = await fs.readFile(configPath, 'utf8')
	} catch (error) {
		console.error(`Failed to read Argus config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return null
	}

	try {
		const parsed = JSON.parse(raw)
		if (isRecord(parsed)) return parsed
		console.error(`Invalid Argus config at ${configPath}: config root must be an object.`)
		process.exitCode = 2
		return null
	} catch (error) {
		console.error(`Invalid Argus config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return null
	}
}

const getPluginSpecs = (config: JsonObject, configPath: string): string[] | null => {
	const value = config.plugins
	if (value === undefined) return []
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
		console.error(`Invalid Argus config at ${configPath}: "plugins" must be an array of non-empty strings.`)
		process.exitCode = 2
		return null
	}
	return value
}

const getPluginAliases = (config: JsonObject, configPath: string): Record<string, string> | null => {
	const value = config.pluginAliases
	if (value === undefined) return {}
	if (!isRecord(value)) {
		console.error(`Invalid Argus config at ${configPath}: "pluginAliases" must be an object with string values.`)
		process.exitCode = 2
		return null
	}

	const aliases: Record<string, string> = {}
	for (const [alias, spec] of Object.entries(value)) {
		if (alias.trim() === '' || typeof spec !== 'string' || spec.trim() === '') {
			console.error(`Invalid Argus config at ${configPath}: "pluginAliases" keys and values must be non-empty strings.`)
			process.exitCode = 2
			return null
		}
		aliases[alias] = spec
	}
	return aliases
}

const writeConfigObject = async (configPath: string, config: JsonObject): Promise<boolean> => {
	try {
		await fs.mkdir(path.dirname(configPath), { recursive: true })
		await fs.writeFile(configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8')
		return true
	} catch (error) {
		console.error(`Failed to write Argus config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
		return false
	}
}

const loadMutablePluginConfig = async (options: PluginConfigMutationOptions): Promise<MutablePluginConfig | null> => {
	if (options.path && options.global) {
		console.error('Use either --path or --global, not both.')
		process.exitCode = 2
		return null
	}

	const target = options.global ? resolveGlobalTargetConfigPath() : resolveTargetConfigPath(process.cwd(), options.path)
	if (!target) return null

	const config = await readConfigObject(target.path, target.exists)
	if (!config) return null

	const plugins = getPluginSpecs(config, target.path)
	if (!plugins) return null
	const pluginAliases = getPluginAliases(config, target.path)
	if (!pluginAliases) return null

	return { path: target.path, config, plugins, pluginAliases }
}

type ParsedPluginAddTarget = {
	spec: string
	alias: string | null
	resolvedSpec: string
}

const parsePluginAddTarget = (raw: string, aliases: Record<string, string>): ParsedPluginAddTarget | null => {
	const trimmed = raw.trim()
	if (!trimmed) return null

	const separator = trimmed.indexOf('=')
	if (separator < 0) {
		const resolved = resolvePluginAlias(trimmed, aliases)
		return { spec: trimmed, alias: resolved.alias, resolvedSpec: resolved.spec }
	}

	const alias = trimmed.slice(0, separator).trim()
	const spec = trimmed.slice(separator + 1).trim()
	return alias && spec ? { spec: alias, alias, resolvedSpec: spec } : null
}

export const runPluginAdd = async (targetSpec: string, options: PluginConfigMutationOptions): Promise<void> => {
	const output = createOutput(options)
	const loaded = await loadMutablePluginConfig(options)
	if (!loaded) return

	const parsed = parsePluginAddTarget(targetSpec, { ...BUILTIN_PLUGIN_ALIASES, ...loaded.pluginAliases })
	if (!parsed) {
		output.writeWarn('Plugin specifier is required.')
		process.exitCode = 2
		return
	}

	const aliases = { ...BUILTIN_PLUGIN_ALIASES, ...loaded.pluginAliases }
	const hasSameResolvedPlugin = loaded.plugins.some((spec) => resolvePluginAlias(spec, aliases).spec === parsed.resolvedSpec)
	const changed = !loaded.plugins.includes(parsed.spec) && !hasSameResolvedPlugin
	const aliasChanged = parsed.alias !== null && loaded.pluginAliases[parsed.alias] !== parsed.resolvedSpec
	if (changed) {
		loaded.plugins = [...loaded.plugins, parsed.spec]
		loaded.config.plugins = loaded.plugins
	}
	if (aliasChanged && parsed.alias) {
		loaded.pluginAliases[parsed.alias] = parsed.resolvedSpec
		loaded.config.pluginAliases = loaded.pluginAliases
	}
	if ((changed || aliasChanged) && !(await writeConfigObject(loaded.path, loaded.config))) return

	const response = {
		configPath: loaded.path,
		spec: parsed.spec,
		alias: parsed.alias,
		resolvedSpec: parsed.resolvedSpec,
		changed: changed || aliasChanged,
		plugins: loaded.plugins,
		pluginAliases: loaded.pluginAliases,
	}

	if (options.json) output.writeJson(response)
	else output.writeHuman(response.changed ? `Added plugin ${parsed.spec} to ${loaded.path}` : `Plugin already configured: ${parsed.spec}`)
}

export const runPluginRemove = async (targetSpec: string, options: PluginConfigMutationOptions): Promise<void> => {
	const output = createOutput(options)
	const normalized = targetSpec.trim()
	if (!normalized) {
		output.writeWarn('Plugin specifier or name is required.')
		process.exitCode = 2
		return
	}

	const loaded = await loadMutablePluginConfig(options)
	if (!loaded) return

	const aliases = { ...BUILTIN_PLUGIN_ALIASES, ...loaded.pluginAliases }
	const next = loaded.plugins.filter((spec) => !matchesPluginSpecifier(spec, normalized, aliases))
	const nextAliases = Object.fromEntries(
		Object.entries(loaded.pluginAliases).filter(([alias, spec]) => !matchesPluginAlias(alias, spec, normalized)),
	)
	const changed = next.length !== loaded.plugins.length
	const aliasChanged = Object.keys(nextAliases).length !== Object.keys(loaded.pluginAliases).length
	if (changed || aliasChanged) {
		loaded.config.plugins = next
		loaded.config.pluginAliases = Object.keys(nextAliases).length > 0 ? nextAliases : undefined
		if (!(await writeConfigObject(loaded.path, loaded.config))) return
	}

	const response = { configPath: loaded.path, target: normalized, changed: changed || aliasChanged, plugins: next, pluginAliases: nextAliases }
	if (options.json) output.writeJson(response)
	else output.writeHuman(response.changed ? `Removed plugin ${normalized} from ${loaded.path}` : `Plugin not configured: ${normalized}`)
}

const matchesPluginSpecifier = (spec: string, target: string, aliases: Record<string, string>): boolean => {
	const resolved = resolvePluginAlias(spec, aliases)
	return (
		spec === target ||
		resolved.spec === target ||
		resolved.alias === target ||
		pluginKey(spec) === pluginKey(target) ||
		pluginKey(resolved.spec) === pluginKey(target)
	)
}

const matchesPluginAlias = (alias: string, spec: string, target: string): boolean =>
	alias === target || spec === target || pluginKey(alias) === pluginKey(target) || pluginKey(spec) === pluginKey(target)

const pluginKey = (value: string): string => {
	const withoutPath = value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? value
	const withoutExt = withoutPath.replace(/\.(mjs|js|ts)$/, '')
	return withoutExt.replace(/^argus-plugin-/, '').replace(/^@[^/]+\/argus-plugin-/, '')
}
