import type { ArgusBrowserHelpers, ArgusDefineWatcherCommand, ArgusPluginHostV1 } from '@vforsh/argus-plugin-api'
import { createOutput } from '../../output/io.js'
import { runChromeOpen } from '../../commands/chrome.js'
import { defineWatcherCommand } from '../defineWatcherCommand.js'
import { requestWatcherJson, writeRequestError } from '../../watchers/requestWatcher.js'

const DEFAULT_TIMEOUT_MS = 30_000

const postWatcherJson = <T>(id: string | undefined, path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS) =>
	requestWatcherJson<T>({
		id,
		path,
		method: 'POST',
		body,
		timeoutMs,
	})

const argus: ArgusBrowserHelpers = {
	eval: (id, request, options) => postWatcherJson(id, '/eval', request, options?.timeoutMs ?? request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	dom: {
		click: (id, request, options) => postWatcherJson(id, '/dom/click', request, options?.timeoutMs),
		info: (id, request, options) => postWatcherJson(id, '/dom/info', request, options?.timeoutMs),
		keydown: (id, request, options) => postWatcherJson(id, '/dom/keydown', request, options?.timeoutMs),
	},
	screenshot: (id, request = {}, options) => postWatcherJson(id, '/screenshot', request, options?.timeoutMs),
}

export const createPluginHost = (): ArgusPluginHostV1 => ({
	createOutput,
	requestWatcherJson,
	writeRequestError,
	runChromeOpen,
	defineWatcherCommand: defineWatcherCommand as ArgusDefineWatcherCommand,
	argus,
})
