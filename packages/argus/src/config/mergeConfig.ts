import path from 'node:path'
import type { PageConsoleLogging } from '@vforsh/argus-core'
import type { ArgusConfigLoadResult, ChromeStartConfig, WatcherInjectConfig } from './types.js'

/**
 * Commander command subset used to detect whether an option value came from
 * the command line (which always wins over config-file defaults).
 */
type OptionSourceProvider = {
	getOptionValueSource: (key: string) => string
}

/** Apply `chrome.start` config defaults to `argus chrome start` options. CLI flags win. */
export const mergeChromeStartOptionsWithConfig = <
	T extends {
		url?: string
		fromWatcher?: string
		profile?: ChromeStartConfig['profile']
		devTools?: boolean
		headless?: boolean
	},
>(
	options: T,
	command: OptionSourceProvider,
	configResult: ArgusConfigLoadResult | null,
): T | null => {
	const chromeStart = configResult?.config.chrome?.start
	if (!chromeStart) {
		return options
	}

	const merged = { ...options }
	merged.url = mergeOption(command, 'url', options.url, chromeStart.url)
	merged.fromWatcher = mergeOption(command, 'fromWatcher', options.fromWatcher, chromeStart.watcherId)
	merged.profile = mergeOption(command, 'profile', options.profile, chromeStart.profile)
	merged.devTools = mergeOption(command, 'devTools', options.devTools, chromeStart.devTools)
	merged.headless = mergeOption(command, 'headless', options.headless, chromeStart.headless)

	if (merged.url && merged.fromWatcher) {
		console.error('Cannot combine --url with --from-watcher. Use one or the other.')
		process.exitCode = 2
		return null
	}

	return merged
}

/**
 * Apply `watcher.start` config defaults to `argus watcher start` options.
 * CLI flags win. Relative `artifacts`/`inject.file` paths from the config are
 * resolved against the config file's directory, not the cwd.
 */
export const mergeWatcherStartOptionsWithConfig = <
	T extends {
		id?: string
		url?: string
		chromeHost?: string
		chromePort?: string | number
		pageIndicator?: boolean
		artifacts?: string
		pageConsoleLogging?: PageConsoleLogging
		inject?: WatcherInjectConfig
	},
>(
	options: T,
	command: OptionSourceProvider,
	configResult: ArgusConfigLoadResult | null,
): T | null => {
	const watcherStart = configResult?.config.watcher?.start
	if (!watcherStart) {
		return options
	}

	const merged = { ...options }
	const configArtifacts = watcherStart.artifacts !== undefined ? path.resolve(configResult.configDir, watcherStart.artifacts) : undefined
	const configInject = watcherStart.inject !== undefined ? resolveInjectPath(configResult.configDir, watcherStart.inject) : undefined

	merged.id = mergeOption(command, 'id', options.id, watcherStart.id)
	merged.url = mergeOption(command, 'url', options.url, watcherStart.url)
	merged.chromeHost = mergeOption(command, 'chromeHost', options.chromeHost, watcherStart.chromeHost)
	merged.chromePort = mergeOption(command, 'chromePort', options.chromePort, watcherStart.chromePort)
	merged.pageIndicator = mergeOption(command, 'pageIndicator', options.pageIndicator, watcherStart.pageIndicator)
	merged.pageConsoleLogging = mergeOption(command, 'pageConsoleLogging', options.pageConsoleLogging, watcherStart.pageConsoleLogging)
	merged.artifacts = mergeOption(command, 'artifacts', options.artifacts, configArtifacts)
	merged.inject = mergeOption(command, 'inject', options.inject, configInject)

	return merged
}

const mergeOption = <T>(command: OptionSourceProvider, key: string, cliValue: T | undefined, configValue: T | undefined): T | undefined => {
	if (command.getOptionValueSource(key) === 'cli') {
		return cliValue
	}
	if (configValue !== undefined) {
		return configValue
	}
	return cliValue
}

const resolveInjectPath = (configDir: string, inject: WatcherInjectConfig): WatcherInjectConfig => ({
	file: path.resolve(configDir, inject.file),
	exposeArgus: inject.exposeArgus,
})
