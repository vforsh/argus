import type { Command } from 'commander'
import type { ArgusConfigLoadResult } from './types.js'
import { loadArgusConfig, resolveArgusConfigPath } from './loadConfig.js'

/**
 * The project config, loaded once per process.
 *
 * `registerPlugins` reads the config before parsing, and each start command used to read
 * it again in its action — so every `argus chrome start`, `argus watcher start`, and
 * `argus start` parsed and validated the file twice, and a malformed config printed its
 * error twice. This cache makes the second read free and the second error impossible.
 *
 * Keyed by resolved path because the `--config` flag can point somewhere other than the
 * discovered project config.
 */
const cache = new Map<string, ArgusConfigLoadResult | null>()

/** Load a config file, reusing an earlier load of the same path. */
export const loadArgusConfigOnce = (resolvedPath: string): ArgusConfigLoadResult | null => {
	const cached = cache.get(resolvedPath)
	if (cached !== undefined) {
		return cached
	}

	const result = loadArgusConfig(resolvedPath)
	cache.set(resolvedPath, result)
	return result
}

/** Reset the cache. Tests that write config files between runs need this. */
export const resetArgusConfigCache = (): void => {
	cache.clear()
}

/** Reads whether an option came from the command line or from a default. */
export type OptionSourceProvider = {
	getOptionValueSource: (key: string) => string
}

/** Wrap a Commander command as an {@link OptionSourceProvider}. */
export const createOptionSourceProvider = (command: Command): OptionSourceProvider => ({
	getOptionValueSource: (key) => command.getOptionValueSource(key) ?? '',
})

/** True when the user actually typed this flag, rather than inheriting a default. */
export const isCliProvided = (command: Command, key: string): boolean => command.getOptionValueSource(key) === 'cli'

/**
 * Resolve command options against the project config.
 *
 * Three register files carried their own ~25-line copy of this ritual — destructure
 * `--config`, resolve the path, bail or load, merge, run — with drift between them.
 *
 * @param merge Applies config values to the CLI options. Receives the source provider so
 *   it can tell a typed flag from a default.
 * @returns The merged options, or `null` when loading or merging failed and the failure
 *   has already been reported.
 */
export const resolveOptionsWithConfig = <T>(
	command: Command,
	cliOptions: T,
	configPath: string | undefined,
	merge: (options: T, sources: OptionSourceProvider, config: ArgusConfigLoadResult) => T | null,
): T | null => {
	const resolvedPath = resolveArgusConfigPath({ cliPath: configPath, cwd: process.cwd() })
	if (!resolvedPath) {
		// An explicit --config that resolves to nothing is an error; no config at all is not.
		return configPath ? null : cliOptions
	}

	const configResult = loadArgusConfigOnce(resolvedPath)
	if (!configResult) {
		return null
	}

	return merge(cliOptions, createOptionSourceProvider(command), configResult)
}
