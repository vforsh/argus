import { setExitCode } from '../../output/exitCode.js'
import { getRequestContext, markMutationDispatched } from '../../session/requestContext.js'
import { watcherArgument } from '../watcherArgument.js'
import type { ArgusBrowserHelpers, ArgusMutationDispatch, ArgusPluginHostV1 } from '@vforsh/argus-plugin-api'
import { createOutput } from '../../output/io.js'
import { runChromeOpen } from '../../commands/chrome.js'
import { defineWatcherCommand } from '../defineWatcherCommand.js'
import { requestWatcherJson, writeRequestError } from '../../watchers/requestWatcher.js'

const DEFAULT_TIMEOUT_MS = 30_000

const postWatcherJson = <T>(id: string | undefined, path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS, mutation?: ArgusMutationDispatch) =>
	requestWatcherJson<T>({
		id,
		path,
		method: 'POST',
		body,
		timeoutMs,
		mutation,
	})

const argus: ArgusBrowserHelpers = {
	eval: (id, request, options) =>
		postWatcherJson(id, '/eval', request, options?.timeoutMs ?? (request.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5000, options?.mutation),
	dom: {
		click: (id, request, options) => postWatcherJson(id, '/dom/click', request, options?.timeoutMs, options?.mutation),
		drag: (id, request, options) => postWatcherJson(id, '/dom/drag', request, options?.timeoutMs, options?.mutation),
		info: (id, request, options) => postWatcherJson(id, '/dom/info', request, options?.timeoutMs, options?.mutation),
		keydown: (id, request, options) => postWatcherJson(id, '/dom/keydown', request, options?.timeoutMs, options?.mutation),
	},
	screenshot: (id, request = {}, options) => postWatcherJson(id, '/screenshot', request, options?.timeoutMs, options?.mutation),
}

export const createPluginHost = (): ArgusPluginHostV1 => ({
	setExitCode,
	getRequestContext,
	markMutationDispatched,
	watcherArgument,
	createOutput,
	requestWatcherJson,
	writeRequestError,
	runChromeOpen,
	defineWatcherCommand,
	argus,
})
