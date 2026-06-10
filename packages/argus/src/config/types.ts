import type { PageConsoleLogging } from '@vforsh/argus-core'

/** Defaults for `argus chrome start`, loaded from the Argus config file. */
export type ChromeStartConfig = {
	url?: string
	watcherId?: string
	profile?: 'temp' | 'default-full' | 'default-medium' | 'default-lite'
	devTools?: boolean
	headless?: boolean
}

/** Script-injection settings for watcher start. `file` is resolved relative to the config dir. */
export type WatcherInjectConfig = {
	file: string
	exposeArgus?: boolean
}

/** Defaults for `argus watcher start`, loaded from the Argus config file. */
export type WatcherStartConfig = {
	id?: string
	url?: string
	chromeHost?: string
	chromePort?: number
	artifacts?: string
	pageIndicator?: boolean
	pageConsoleLogging?: PageConsoleLogging
	inject?: WatcherInjectConfig
}

/** Root shape of the Argus config file (`.argus/config.json` and friends). */
export type ArgusConfig = {
	chrome?: {
		start?: ChromeStartConfig
	}
	watcher?: {
		start?: WatcherStartConfig
	}
	/**
	 * Optional CLI plugins to load at startup.
	 * Each entry is a Node/Bun module specifier (e.g. "@vforsh/argus-plugin-yagames")
	 * or a path resolvable from the config directory / cwd (e.g. "./plugins/yagames.js").
	 */
	plugins?: string[]
	/**
	 * Optional aliases for plugin specifiers. Aliases are resolved before normal
	 * module resolution, so `argus --plugin sheets ...` can point at a full package.
	 */
	pluginAliases?: Record<string, string>
}

/** Result of loading a config file. `configDir` anchors relative-path resolution. */
export type ArgusConfigLoadResult = {
	config: ArgusConfig
	configDir: string
}
