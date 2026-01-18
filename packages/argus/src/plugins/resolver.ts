import { resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginConfig, PluginConfigObject, ResolvedPlugin } from '@vforsh/argus-core'

/**
 * Resolves plugin configs to absolute module paths.
 */
export async function resolvePlugins(configs: PluginConfig[], configDir: string): Promise<ResolvedPlugin[]> {
	const resolved: ResolvedPlugin[] = []

	for (const config of configs) {
		try {
			const plugin = await resolvePlugin(config, configDir)
			resolved.push(plugin)
		} catch (error) {
			throw new PluginResolveError(`Failed to resolve plugin: ${JSON.stringify(config)}`, { cause: error })
		}
	}

	return resolved
}

async function resolvePlugin(config: PluginConfig, configDir: string): Promise<ResolvedPlugin> {
	const normalized = normalizePluginConfig(config)
	const { name, module: moduleSpecifier, enabled, config: pluginConfig } = normalized

	const modulePath = await resolveModulePath(moduleSpecifier, configDir)

	return {
		name,
		moduleSpecifier,
		modulePath,
		enabled: enabled ?? true,
		config: pluginConfig,
	}
}

function normalizePluginConfig(config: PluginConfig): PluginConfigObject {
	if (typeof config === 'string') {
		return {
			name: derivePluginName(config),
			module: config,
			enabled: true,
		}
	}

	return {
		name: config.name,
		module: config.module,
		enabled: config.enabled ?? true,
		config: config.config,
	}
}

function derivePluginName(moduleSpecifier: string): string {
	if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
		const basename = moduleSpecifier.split('/').pop() || moduleSpecifier
		return basename.replace(/\.(js|ts|mjs|cjs)$/, '')
	}

	return moduleSpecifier
}

async function resolveModulePath(moduleSpecifier: string, configDir: string): Promise<string> {
	if (isAbsolute(moduleSpecifier)) {
		return moduleSpecifier
	}

	if (moduleSpecifier.startsWith('.')) {
		return resolve(configDir, moduleSpecifier)
	}

	try {
		if (typeof import.meta.resolve === 'function') {
			const resolved = await import.meta.resolve(moduleSpecifier, pathToFileURL(configDir + '/'))
			return new URL(resolved).pathname
		}
	} catch {
		// Fall through to require.resolve
	}

	try {
		const { createRequire } = await import('node:module')
		const require = createRequire(resolve(configDir, 'package.json'))
		return require.resolve(moduleSpecifier)
	} catch (error) {
		throw new Error(
			`Cannot resolve plugin module: ${moduleSpecifier}\n` +
				`Tried resolving from: ${configDir}\n` +
				`Make sure the package is installed or the path is correct.`,
			{ cause: error },
		)
	}
}

class PluginResolveError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'PluginResolveError'
	}
}
