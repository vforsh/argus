import type {
	PluginArgusApi,
	PluginApiErrorCode,
	PluginContext,
	PluginEvalInput,
	PluginEvalOutput,
	PluginListWatcherResult,
	PluginListWatchersOptions,
	PluginResolveWatcherInput,
	PluginResolveWatcherResult,
	WatcherRecord,
} from '@vforsh/argus-core'
import { createArgusClient, type ListResult } from '@vforsh/argus-client'
import { evalWithRetries } from '../eval/evalClient.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'

export class ArgusPluginApiError extends Error {
	readonly code: PluginApiErrorCode
	readonly candidates?: WatcherRecord[]
	readonly watcherId?: string
	readonly exception?: { text: string; details?: unknown }

	constructor(options: {
		code: PluginApiErrorCode
		message: string
		candidates?: WatcherRecord[]
		watcherId?: string
		exception?: { text: string; details?: unknown }
	}) {
		super(options.message)
		this.name = 'ArgusPluginApiError'
		this.code = options.code
		this.candidates = options.candidates
		this.watcherId = options.watcherId
		this.exception = options.exception
	}
}

export function createPluginArgusApi(_baseContext: Omit<PluginContext, 'config' | 'argus'>): PluginArgusApi {
	const client = createArgusClient()

	return {
		async resolveWatcher(input?: PluginResolveWatcherInput): Promise<PluginResolveWatcherResult> {
			const result = await resolveWatcher({ id: input?.id })
			if (!result.ok) {
				return { ok: false, error: result.error, candidates: result.candidates }
			}
			return { ok: true, watcher: result.watcher }
		},

		async listWatchers(options?: PluginListWatchersOptions): Promise<PluginListWatcherResult[]> {
			const results = await client.list({ byCwd: options?.byCwd })
			return results.map((entry: ListResult) => ({
				watcher: entry.watcher,
				reachable: entry.reachable,
				error: entry.reachable ? undefined : entry.error,
			}))
		},

		async eval(input: PluginEvalInput): Promise<PluginEvalOutput> {
			if (!input.expression || input.expression.trim() === '') {
				throw new ArgusPluginApiError({
					code: 'expression_required',
					message: 'expression is required',
				})
			}

			const resolved = await resolveWatcher({ id: input.watcherId })
			if (!resolved.ok) {
				const code: PluginApiErrorCode = resolved.candidates?.length ? 'watcher_required' : 'watcher_not_found'
				throw new ArgusPluginApiError({
					code,
					message: resolved.error,
					candidates: resolved.candidates,
				})
			}

			const { watcher } = resolved
			const awaitPromise = input.awaitPromise ?? true
			const returnByValue = input.returnByValue ?? true
			const failOnException = input.failOnException ?? true
			const retryCount = input.retryCount ?? 0

			const result = await evalWithRetries({
				watcher,
				expression: input.expression,
				awaitPromise,
				returnByValue,
				timeoutMs: input.timeoutMs,
				failOnException,
				retryCount,
			})

			if (!result.ok) {
				if (result.kind === 'transport') {
					throw new ArgusPluginApiError({
						code: 'eval_transport',
						message: result.error,
						watcherId: watcher.id,
					})
				}

				throw new ArgusPluginApiError({
					code: 'eval_exception',
					message: result.error,
					watcherId: watcher.id,
					exception: result.response?.exception
						? { text: result.response.exception.text, details: result.response.exception.details }
						: undefined,
				})
			}

			return {
				watcherId: watcher.id,
				result: result.response.result,
				type: result.response.type ?? null,
				exception: result.response.exception ? { text: result.response.exception.text, details: result.response.exception.details } : null,
			}
		},
	}
}
