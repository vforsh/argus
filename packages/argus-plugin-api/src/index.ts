import type {
	DomClickRequest,
	DomClickResponse,
	DomDragRequest,
	DomDragResponse,
	DomInfoRequest,
	DomInfoResponse,
	DomKeydownRequest,
	DomKeydownResponse,
	EvalRequest,
	EvalResponse,
	HttpMethod,
	ProtocolSchema,
	ScreenshotRequest,
	ScreenshotResponse,
	WatcherRecord,
} from '@vforsh/argus-core'
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

/**
 * Plan for a watcher request produced by a plugin command.
 *
 * The same path/method/body/query/timeout shape as {@link ArgusWatcherRequestInput}: a
 * command spec cannot pick the watcher (`id` comes from the CLI argument) or ask for the
 * raw error response (the runner owns failure rendering), and it never issues a PUT.
 */
export type ArgusWatcherCommandRequestPlan<TMeta = undefined> = Omit<ArgusWatcherRequestInput, 'id' | 'returnErrorResponse' | 'method'> & {
	/** HTTP method. Defaults to `'POST'` when `body` is set, else `'GET'`. */
	method?: 'GET' | 'POST'
	/**
	 * Values `build` derived, handed back to the formatters.
	 *
	 * Without this a formatter could only re-derive what `build` already computed — with
	 * non-null assertions on inputs `build` had validated — or smuggle payloads through
	 * the positional-argument tuple, which is what several commands did.
	 */
	meta?: TMeta
}

/** Context passed to plugin command formatters after a successful watcher request. */
export type ArgusWatcherCommandContext<TArgs extends readonly unknown[], TOptions, TMeta = undefined> = {
	output: ArgusOutput
	watcher: WatcherRecord
	args: TArgs
	options: TOptions
	/** Whatever `build` put on {@link ArgusWatcherCommandRequestPlan.meta}. */
	meta: TMeta
}

/** Stable watcher-backed command spec for plugins. */
export type ArgusWatcherCommandSpec<
	TArgs extends readonly unknown[],
	TOptions extends { json?: boolean },
	TBody,
	TResponse extends { ok: true },
	TMeta = undefined,
> = {
	build: (
		args: TArgs,
		options: TOptions,
		output: ArgusOutput,
	) => Promise<ArgusWatcherCommandRequestPlan<TMeta> | null> | ArgusWatcherCommandRequestPlan<TMeta> | null
	isJson?: (options: TOptions) => boolean
	schema?: ProtocolSchema<TBody>
	formatHuman?: (response: TResponse, ctx: ArgusWatcherCommandContext<TArgs, TOptions, TMeta>) => void
	formatJson?: (response: TResponse, ctx: ArgusWatcherCommandContext<TArgs, TOptions, TMeta>) => unknown
}

/** Commander-compatible action runner for a plugin watcher command. */
export type ArgusWatcherCommandRunner<TArgs extends readonly unknown[], TOptions> = (
	id: string | undefined,
	...rest: [...TArgs, TOptions]
) => Promise<void>

/** Factory for Argus' stable watcher command runner. */
export type ArgusDefineWatcherCommand = <
	TOptions extends { json?: boolean },
	TResponse extends { ok: true },
	TBody = unknown,
	TArgs extends readonly unknown[] = [],
	TMeta = undefined,
>(
	spec: ArgusWatcherCommandSpec<TArgs, TOptions, TBody, TResponse, TMeta>,
) => ArgusWatcherCommandRunner<TArgs, TOptions>

/** Optional request timeout override for high-level plugin browser helpers. */
export type ArgusBrowserHelperOptions = {
	timeoutMs?: number
}

/** High-level browser helpers exposed to plugins for common watcher operations. */
export type ArgusBrowserHelpers = {
	eval: (id: string | undefined, request: EvalRequest, options?: ArgusBrowserHelperOptions) => Promise<ArgusWatcherRequestResult<EvalResponse>>
	dom: {
		click: (
			id: string | undefined,
			request: DomClickRequest,
			options?: ArgusBrowserHelperOptions,
		) => Promise<ArgusWatcherRequestResult<DomClickResponse>>
		drag: (
			id: string | undefined,
			request: DomDragRequest,
			options?: ArgusBrowserHelperOptions,
		) => Promise<ArgusWatcherRequestResult<DomDragResponse>>
		info: (
			id: string | undefined,
			request: DomInfoRequest,
			options?: ArgusBrowserHelperOptions,
		) => Promise<ArgusWatcherRequestResult<DomInfoResponse>>
		keydown: (
			id: string | undefined,
			request: DomKeydownRequest,
			options?: ArgusBrowserHelperOptions,
		) => Promise<ArgusWatcherRequestResult<DomKeydownResponse>>
	}
	screenshot: (
		id: string | undefined,
		request?: ScreenshotRequest,
		options?: ArgusBrowserHelperOptions,
	) => Promise<ArgusWatcherRequestResult<ScreenshotResponse>>
}

/** Host helpers that plugins can rely on across Argus releases. */
export type ArgusPluginHostV1 = {
	createOutput: ArgusCreateOutput
	requestWatcherJson: ArgusRequestWatcherJson
	writeRequestError: ArgusWriteRequestError
	runChromeOpen: ArgusRunChromeOpen
	defineWatcherCommand: ArgusDefineWatcherCommand
	argus: ArgusBrowserHelpers
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
	version?: string
	description?: string
	commands?: string[]
	homepage?: string
	minArgusVersion?: string
	register: (ctx: ArgusPluginContextV1) => void | Promise<void>
}
