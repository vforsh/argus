import type { HttpMethod, WatcherRecord } from '@vforsh/argus-core'
import type { Command } from 'commander'

/** Version tag that plugin modules must export so Argus can reject incompatible contracts. */
export const ARGUS_PLUGIN_API_VERSION = 1 as const

/** Output mode selection for Argus' stdout/stderr helpers. */
export type ArgusOutputOptions = {
	json?: boolean
}

/**
 * Output helpers exposed to plugins.
 * JSON goes to stdout; human output goes to stdout unless JSON mode is enabled; warnings always go to stderr.
 */
export type ArgusOutput = {
	json: boolean
	writeJson: (value: unknown) => void
	writeJsonLine: (value: unknown) => void
	writeHuman: (text: string) => void
	writeWarn: (text: string) => void
}

/** Factory for Argus' standard output helpers. */
export type ArgusCreateOutput = (options: ArgusOutputOptions) => ArgusOutput

/** Input for a one-shot watcher HTTP request. */
export type ArgusWatcherRequestInput = {
	id?: string
	path: string
	query?: URLSearchParams
	method?: HttpMethod
	body?: unknown
	timeoutMs?: number
	returnErrorResponse?: boolean
}

/** Successful watcher request result. */
export type ArgusWatcherRequestSuccess<T> = {
	ok: true
	watcher: WatcherRecord
	data: T
}

/** Failed watcher request result. */
export type ArgusWatcherRequestError = {
	ok: false
	watcher?: WatcherRecord
	exitCode: number
	message: string
	candidates?: WatcherRecord[]
}

/** Combined watcher request result. */
export type ArgusWatcherRequestResult<T> = ArgusWatcherRequestSuccess<T> | ArgusWatcherRequestError

/** Shared helper for watcher requests. */
export type ArgusRequestWatcherJson = <T>(input: ArgusWatcherRequestInput) => Promise<ArgusWatcherRequestResult<T>>

/** Argus-standard printer for watcher request failures. */
export type ArgusWriteRequestError = (result: ArgusWatcherRequestError, output: ArgusOutput) => void

/** Options accepted by the host helper that opens a new Chrome tab. */
export type ArgusChromeOpenOptions = {
	cdp?: string
	id?: string
	json?: boolean
	url: string
}

/** Open a new tab via Chrome CDP using the same resolution rules as the built-in CLI command. */
export type ArgusRunChromeOpen = (options: ArgusChromeOpenOptions) => Promise<void>

/** Host helpers that plugins can rely on across Argus releases. */
export type ArgusPluginHostV1 = {
	createOutput: ArgusCreateOutput
	requestWatcherJson: ArgusRequestWatcherJson
	writeRequestError: ArgusWriteRequestError
	runChromeOpen: ArgusRunChromeOpen
}

/** Context passed to a plugin during registration. */
export type ArgusPluginContextV1 = {
	apiVersion: typeof ARGUS_PLUGIN_API_VERSION
	program: Command
	host: ArgusPluginHostV1
	cwd: string
	configPath: string | null
	configDir: string | null
}

/** Plugin module contract consumed by Argus' plugin loader. */
export type ArgusPluginV1 = {
	apiVersion: typeof ARGUS_PLUGIN_API_VERSION
	name: string
	register: (ctx: ArgusPluginContextV1) => void | Promise<void>
}
