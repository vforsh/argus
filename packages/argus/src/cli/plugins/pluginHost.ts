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

/**
 * Give one plugin a host that names itself when the plugin reaches for a helper this build lacks.
 *
 * The v1 host grew additively (`watcherArgument`, `argus.dom.*`, …) without bumping
 * `ARGUS_PLUGIN_API_VERSION`, so a plugin built against a newer `@vforsh/argus-plugin-api` passes
 * the version check and then dies with `ctx.host.watcherArgument is not a function` — no plugin
 * name, no versions, no fix. Missing members now throw that explanation at the access site.
 */
export const guardPluginHost = <T extends object>(
	host: T,
	plugin: { name: string; version?: string; apiVersion: unknown },
	argusVersion: string,
	hostApiVersion: number,
): T => guard(host, 'ctx.host', (path) => describeMissingHelper(path, plugin, argusVersion, hostApiVersion))

/** Error for a plugin that needs a host helper this Argus does not provide. */
export class PluginHostSkewError extends Error {}

const guard = <T extends object>(target: T, path: string, describe: (path: string) => string): T =>
	new Proxy(target, {
		get: (object, key, receiver) => {
			const value = Reflect.get(object, key, receiver)
			if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return value
			if (!(key in object)) throw new PluginHostSkewError(describe(`${path}.${key}`))
			// Nested helper namespaces (`argus.dom`) are guarded too; functions and class instances pass through.
			return isPlainObject(value) ? guard(value, `${path}.${key}`, describe) : value
		},
	})

const isPlainObject = (value: unknown): value is object => {
	if (!value || typeof value !== 'object') return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

const describeMissingHelper = (
	path: string,
	plugin: { name: string; version?: string; apiVersion: unknown },
	argusVersion: string,
	hostApiVersion: number,
): string => {
	const pluginLabel = `Plugin "${plugin.name}"${plugin.version ? ` ${plugin.version}` : ''}`
	return (
		`${pluginLabel} (plugin API ${String(plugin.apiVersion)}) calls ${path}, which Argus ${argusVersion} (plugin API ${hostApiVersion}) does not provide: ` +
		'the plugin was built against a different @vforsh/argus-plugin-api than this Argus ships. ' +
		'Fix: update Argus (`npm i -g @vforsh/argus@latest`), or rebuild the plugin against the installed Argus. Check: `argus plugin list`.'
	)
}
