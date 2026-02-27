import type { Command } from 'commander'

import type { createOutput } from './output/io.js'
import type { requestWatcherJson, writeRequestError } from './watchers/requestWatcher.js'
import type { runChromeOpen } from './commands/chrome.js'

export const ARGUS_PLUGIN_API_VERSION = 1 as const

export type ArgusPluginHostV1 = {
	/** Argus stdout/stderr contract helper (JSON to stdout, human to stdout, warnings to stderr). */
	createOutput: typeof createOutput
	/** Low-level helper: resolve watcher from registry and send an HTTP JSON request. */
	requestWatcherJson: typeof requestWatcherJson
	/** Argus-standard error printer for watcher request failures. */
	writeRequestError: typeof writeRequestError
	/** Open a new tab via Chrome CDP. */
	runChromeOpen: typeof runChromeOpen
}

export type ArgusPluginContextV1 = {
	apiVersion: typeof ARGUS_PLUGIN_API_VERSION
	program: Command
	host: ArgusPluginHostV1
	cwd: string
	configPath: string | null
	configDir: string | null
}

export type ArgusPluginV1 = {
	apiVersion: typeof ARGUS_PLUGIN_API_VERSION
	name: string
	register: (ctx: ArgusPluginContextV1) => void | Promise<void>
}
