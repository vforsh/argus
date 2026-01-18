import { pathToFileURL } from 'node:url'
import type { Command } from 'commander'
import type { ResolvedPlugin, ArgusPlugin, PluginContext, PluginLoadError } from '@vforsh/argus-core'

/**
 * Loads and validates plugin modules.
 */
export async function loadPlugins(resolved: ResolvedPlugin[], context: Omit<PluginContext, 'config'>): Promise<LoadedPlugin[]> {
	const loaded: LoadedPlugin[] = []
	const errors: PluginLoadError[] = []

	for (const plugin of resolved) {
		if (!plugin.enabled) {
			continue
		}

		try {
			const loadedPlugin = await loadPlugin(plugin, context)
			loaded.push(loadedPlugin)
		} catch (error) {
			errors.push({
				plugin: plugin.name,
				error: error as Error,
				phase: 'load',
			})
		}
	}

	if (errors.length > 0) {
		throw new PluginLoadErrors(errors)
	}

	return loaded
}

async function loadPlugin(plugin: ResolvedPlugin, baseContext: Omit<PluginContext, 'config'>): Promise<LoadedPlugin> {
	let module: unknown
	try {
		const fileUrl = pathToFileURL(plugin.modulePath).href
		module = await import(fileUrl)
	} catch (error) {
		throw new Error(`Failed to import plugin module: ${plugin.modulePath}`, { cause: error })
	}

	const pluginExports = validatePluginExports(module, plugin.name)

	const context: PluginContext = {
		...baseContext,
		config: plugin.config,
	}

	if (pluginExports.setup) {
		try {
			await pluginExports.setup(context)
		} catch (error) {
			throw new Error(`Plugin setup failed: ${plugin.name}`, { cause: error })
		}
	}

	return {
		name: plugin.name,
		command: pluginExports.command,
		teardown: pluginExports.teardown,
	}
}

function validatePluginExports(module: unknown, pluginName: string): ArgusPlugin {
	if (!module || typeof module !== 'object') {
		throw new Error(`Plugin must export an object: ${pluginName}`)
	}

	const exports = module as Record<string, unknown>

	const pluginExports = exports.default as ArgusPlugin | undefined

	if (!pluginExports) {
		throw new Error(`Plugin must have a default export: ${pluginName}\n` + `Expected: export default { command: Command }`)
	}

	if (!pluginExports.command) {
		throw new Error(`Plugin must export a "command" property: ${pluginName}`)
	}

	if (typeof pluginExports.command.name !== 'function') {
		throw new Error(
			`Plugin "command" must be a Commander.js Command instance: ${pluginName}\n` + `Did you forget to instantiate? Try: new Command('name')`,
		)
	}

	if (pluginExports.setup && typeof pluginExports.setup !== 'function') {
		throw new Error(`Plugin "setup" must be a function: ${pluginName}`)
	}

	if (pluginExports.teardown && typeof pluginExports.teardown !== 'function') {
		throw new Error(`Plugin "teardown" must be a function: ${pluginName}`)
	}

	return pluginExports
}

export interface LoadedPlugin {
	name: string
	command: Command
	teardown?: () => void | Promise<void>
}

class PluginLoadErrors extends Error {
	constructor(public errors: PluginLoadError[]) {
		const errorSummary = errors.map((e) => `  - ${e.plugin} (${e.phase}): ${e.error.message}`).join('\n')

		super(`Failed to load ${errors.length} plugin(s):\n${errorSummary}\n\n` + `Check your .argus/config.json "plugins" configuration.`)
		this.name = 'PluginLoadErrors'
	}
}
