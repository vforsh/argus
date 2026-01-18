import type { Command } from 'commander'
import type { ArgusConfig } from '../config/argusConfig.js'
import { resolvePlugins } from './resolver.js'
import { loadPlugins, type LoadedPlugin } from './loader.js'

/**
 * Main plugin system orchestrator.
 * Resolves, loads, and registers plugins.
 */
export class PluginRegistry {
	private plugins: LoadedPlugin[] = []

	async loadFromConfig(
		config: ArgusConfig,
		context: {
			cwd: string
			configDir: string
			argusConfig: ArgusConfig
		},
	): Promise<void> {
		if (!config.plugins || config.plugins.length === 0) {
			return
		}

		const resolved = await resolvePlugins(config.plugins, context.configDir)

		this.plugins = await loadPlugins(resolved, context)
	}

	registerWith(program: Command): void {
		const existingCommands = program.commands.map((c) => c.name())
		const pluginCommands = this.plugins.map((p) => p.command.name())

		const duplicates = pluginCommands.filter((name, index) => pluginCommands.indexOf(name) !== index)

		if (duplicates.length > 0) {
			throw new Error(`Duplicate plugin commands detected: ${duplicates.join(', ')}\n` + `Each plugin must have a unique command name.`)
		}

		const conflicts = pluginCommands.filter((name) => existingCommands.includes(name))

		if (conflicts.length > 0) {
			throw new Error(
				`Plugin commands conflict with built-in commands: ${conflicts.join(', ')}\n` + `Choose different command names for your plugins.`,
			)
		}

		for (const plugin of this.plugins) {
			program.addCommand(plugin.command)
		}
	}

	async cleanup(): Promise<void> {
		for (const plugin of this.plugins) {
			if (plugin.teardown) {
				try {
					await plugin.teardown()
				} catch (error) {
					console.error(`Plugin teardown failed: ${plugin.name}`, error)
				}
			}
		}
	}
}
