import type { Command } from 'commander'

/**
 * Plugin configuration from argus config file.
 * Supports string shorthand or detailed object format.
 */
export type PluginConfig = string | PluginConfigObject

export interface PluginConfigObject {
	/**
	 * Unique plugin identifier (for logging/debugging).
	 */
	name: string

	/**
	 * Module path or npm package name.
	 * Examples: "./plugins/gameX.js", "gameX-argus-plugin"
	 */
	module: string

	/**
	 * Whether plugin is enabled (default: true).
	 */
	enabled?: boolean

	/**
	 * Plugin-specific configuration (passed to plugin's setup hook).
	 */
	config?: Record<string, unknown>
}

/**
 * Normalized plugin descriptor after resolution.
 */
export interface ResolvedPlugin {
	/**
	 * Plugin identifier (from config.name or derived from module).
	 */
	name: string

	/**
	 * Original module specifier from config.
	 */
	moduleSpecifier: string

	/**
	 * Absolute path to the plugin module (resolved).
	 */
	modulePath: string

	/**
	 * Whether plugin is enabled.
	 */
	enabled: boolean

	/**
	 * Plugin-specific config.
	 */
	config?: Record<string, unknown>
}

/**
 * Plugin module exports (default export).
 */
export interface ArgusPlugin {
	/**
	 * Commander.js Command instance.
	 * This is the primary plugin export - a fully configured Command.
	 */
	command: Command

	/**
	 * Optional setup hook called before command registration.
	 * Use for validation, initialization, or side effects.
	 */
	setup?: (context: PluginContext) => void | Promise<void>

	/**
	 * Optional cleanup hook called on CLI exit.
	 */
	teardown?: () => void | Promise<void>
}

/**
 * Context passed to plugin setup hooks.
 */
export interface PluginContext {
	/**
	 * Plugin configuration from argus config.
	 */
	config?: Record<string, unknown>

	/**
	 * Current working directory.
	 */
	cwd: string

	/**
	 * Argus config directory (.argus/ or directory containing argus.config.json).
	 */
	configDir: string

	/**
	 * Full argus configuration (read-only).
	 */
	argusConfig: unknown
}

/**
 * Plugin loading error details.
 */
export interface PluginLoadError {
	plugin: string
	error: Error
	phase: 'resolve' | 'load' | 'validate' | 'setup'
}
