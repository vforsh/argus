import type { Command } from 'commander'
import type { WatcherRecord } from './registry/types.js'

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
	 * Argus config directory (.argus/, .config/, or directory containing argus.config.json).
	 */
	configDir: string

	/**
	 * Full argus configuration (read-only).
	 */
	argusConfig: unknown

	/**
	 * Argus API for interacting with watchers and evaluating JavaScript in watched pages.
	 */
	argus: PluginArgusApi
}

/**
 * API for plugins to interact with Argus watchers.
 */
export interface PluginArgusApi {
	/**
	 * Resolve a watcher using the same selection logic as `argus eval`.
	 *
	 * When `id` is omitted:
	 * 1. If exactly one watcher matches cwd, use it.
	 * 2. If exactly one watcher is reachable, use it.
	 * 3. Otherwise, returns an error with candidates.
	 *
	 * @param input - Optional input with watcher id.
	 * @returns A promise resolving to the watcher or an error with candidates.
	 */
	resolveWatcher(input?: PluginResolveWatcherInput): Promise<PluginResolveWatcherResult>

	/**
	 * List all watchers, optionally filtered by cwd.
	 *
	 * @param options - Optional filtering options.
	 * @returns A promise resolving to a list of watchers with reachability status.
	 */
	listWatchers(options?: PluginListWatchersOptions): Promise<PluginListWatcherResult[]>

	/**
	 * Evaluate a JavaScript expression in the watched page.
	 *
	 * Uses the watcher's `/eval` HTTP endpoint (CDP `Runtime.evaluate`).
	 * Supports retries and timeout configuration.
	 *
	 * @param input - Evaluation input including expression and options.
	 * @returns A promise resolving to the evaluation result.
	 * @throws {ArgusPluginApiError} When watcher resolution fails or eval errors with failOnException=true.
	 *
	 * @example
	 * ```typescript
	 * // Simple usage
	 * const result = await context.argus.eval({ expression: 'document.title' })
	 * console.log(result.result) // "My Page Title"
	 *
	 * // With options
	 * const result = await context.argus.eval({
	 *   expression: 'fetch("/api/data").then(r => r.json())',
	 *   watcherId: 'my-watcher',
	 *   timeoutMs: 10000,
	 *   retryCount: 3,
	 *   failOnException: false
	 * })
	 * ```
	 */
	eval(input: PluginEvalInput): Promise<PluginEvalOutput>
}

/**
 * Input for resolving a watcher.
 */
export interface PluginResolveWatcherInput {
	/**
	 * Specific watcher id to resolve. If omitted, uses automatic selection.
	 */
	id?: string
}

/**
 * Result of watcher resolution.
 */
export type PluginResolveWatcherResult = { ok: true; watcher: WatcherRecord } | { ok: false; error: string; candidates?: WatcherRecord[] }

/**
 * Options for listing watchers.
 */
export interface PluginListWatchersOptions {
	/**
	 * Filter watchers by cwd (substring match).
	 */
	byCwd?: string
}

/**
 * Watcher list result with reachability status.
 */
export interface PluginListWatcherResult {
	/**
	 * The watcher record.
	 */
	watcher: WatcherRecord

	/**
	 * Whether the watcher is reachable.
	 */
	reachable: boolean

	/**
	 * Error message if watcher is not reachable.
	 */
	error?: string
}

/**
 * Input for evaluating JavaScript in a watched page.
 */
export interface PluginEvalInput {
	/**
	 * JavaScript expression to evaluate. Required.
	 */
	expression: string

	/**
	 * Specific watcher id. If omitted, uses automatic selection.
	 */
	watcherId?: string

	/**
	 * Whether to await promise results.
	 * @default true
	 */
	awaitPromise?: boolean

	/**
	 * Whether to return the result by value (serialized).
	 * @default true
	 */
	returnByValue?: boolean

	/**
	 * Timeout in milliseconds for the CDP call.
	 */
	timeoutMs?: number

	/**
	 * Number of retry attempts on transport failure.
	 * @default 0
	 */
	retryCount?: number

	/**
	 * Whether to throw on JavaScript exceptions.
	 * @default true
	 */
	failOnException?: boolean
}

/**
 * Output from evaluating JavaScript in a watched page.
 */
export interface PluginEvalOutput {
	/**
	 * The watcher id that executed the eval.
	 */
	watcherId: string

	/**
	 * The evaluation result value.
	 */
	result: unknown

	/**
	 * The CDP type of the result (e.g., "string", "number", "object").
	 */
	type: string | null

	/**
	 * Exception details if the evaluation threw an error.
	 */
	exception: PluginEvalException | null
}

/**
 * JavaScript exception from eval.
 */
export interface PluginEvalException {
	/**
	 * Exception message text.
	 */
	text: string

	/**
	 * Additional exception details (stack trace, etc.).
	 */
	details?: unknown
}

/**
 * Error codes for ArgusPluginApiError.
 */
export type PluginApiErrorCode =
	| 'expression_required'
	| 'watcher_required'
	| 'watcher_not_found'
	| 'watcher_unreachable'
	| 'eval_exception'
	| 'eval_transport'

/**
 * Plugin loading error details.
 */
export interface PluginLoadError {
	plugin: string
	error: Error
	phase: 'resolve' | 'load' | 'validate' | 'setup'
}
