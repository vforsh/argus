import type { StatusResponse } from '@vforsh/argus-core'
import type { ChromeTargetResponse } from '../cdp/types.js'
import type { CdpEndpointOptions } from '../cdp/resolveCdpEndpoint.js'
import { resolveCdpEndpoint } from '../cdp/resolveCdpEndpoint.js'
import { sendCdpCommand } from '../cdp/sendCdpCommand.js'
import { selectTargetFromCandidates } from '../cdp/selectTarget.js'
import { fetchJson } from '../httpClient.js'
import { createOutput, type Output } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import { resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { loadChromeTargets } from './chrome/shared.js'

export type PageEndpointOptions = CdpEndpointOptions

export type PageCommandOptions = PageEndpointOptions & {
	json?: boolean
}

const parseParamPair = (value: string): { key: string; value: string } | { error: string } => {
	const eqIdx = value.indexOf('=')
	if (eqIdx === -1) {
		return { error: `Invalid --param "${value}": missing "=".` }
	}
	const key = value.slice(0, eqIdx)
	if (key === '') {
		return { error: `Invalid --param "${value}": empty key.` }
	}
	return { key, value: value.slice(eqIdx + 1) }
}

const parseParamsString = (value: string): URLSearchParams | { error: string } => {
	const params = new URLSearchParams()
	if (value.trim() === '') {
		return params
	}

	const pairs = value.split('&')
	for (const pair of pairs) {
		const eqIdx = pair.indexOf('=')
		if (eqIdx === -1) {
			return { error: `Invalid --params "${pair}": missing "=".` }
		}
		const key = pair.slice(0, eqIdx)
		if (key === '') {
			return { error: `Invalid --params "${pair}": empty key.` }
		}
		params.set(decodeURIComponent(key), decodeURIComponent(pair.slice(eqIdx + 1)))
	}
	return params
}

const isHttpUrl = (url: string): boolean => {
	return url.startsWith('http://') || url.startsWith('https://')
}

export type PageReloadOptions = PageCommandOptions & {
	targetId?: string
	param?: string[]
	params?: string
}

/**
 * Reload the page, optionally rewriting query params.
 *
 * A target is reached one of two ways — by explicit `targetId`, or by resolving the page a
 * watcher is attached to — and both paths then do the same thing. This used to be two
 * branches that each hand-wrote watcher resolution, candidate printing, and `/json/list`
 * fetching that `resolveWatcherOrExit` and `loadChromeTargets` already wrap.
 */
export const runPageReload = async (options: PageReloadOptions): Promise<void> => {
	const output = createOutput(options)

	const target = await resolveReloadTarget(options, output)
	if (!target) return

	await reloadTarget(target, {
		hasParamFlag: (options.param?.length ?? 0) > 0,
		hasParamsFlag: options.params != null,
		options,
		output,
	})
}

/** Resolve the target to reload, by explicit id or via the watcher's attached page. */
const resolveReloadTarget = async (options: PageReloadOptions, output: Output): Promise<ChromeTargetResponse | null> => {
	const explicitId = options.targetId?.trim()

	if (!explicitId && options.id) {
		return await resolveAttachedTarget(options, output)
	}

	if (!explicitId) {
		output.writeWarn('Provide a targetId or use --id <watcherId> to reload the attached page.')
		process.exitCode = 2
		return null
	}

	const endpoint = await resolveCdpEndpoint(options)
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return null
	}

	const targets = await loadChromeTargets(endpoint, output)
	if (!targets) return null

	const target = targets.find((entry) => entry.id === explicitId)
	if (!target) {
		output.writeWarn(`Target not found: ${explicitId}`)
		process.exitCode = 2
		return null
	}

	return target
}

/** Find the Chrome target a watcher is currently attached to. */
const resolveAttachedTarget = async (options: PageReloadOptions, output: Output): Promise<ChromeTargetResponse | null> => {
	if (options.cdp) {
		output.writeWarn('--cdp cannot be used without a targetId. Use --id to resolve the endpoint.')
		process.exitCode = 2
		return null
	}

	const resolved = await resolveWatcherOrExit({ id: options.id }, output)
	if (!resolved) return null

	const statusUrl = `http://${resolved.watcher.host}:${resolved.watcher.port}/status`
	let status: StatusResponse
	try {
		status = await fetchJson<StatusResponse>(statusUrl, { timeoutMs: 2_000 })
	} catch (error) {
		output.writeWarn(`${resolved.watcher.id}: failed to reach watcher (${formatError(error)})`)
		process.exitCode = 1
		return null
	}

	if (!status.attached || !status.target) {
		output.writeWarn(`Watcher ${resolved.watcher.id} is not attached to a target.`)
		process.exitCode = 1
		return null
	}

	const endpoint = await resolveCdpEndpoint({ id: resolved.watcher.id })
	if (!endpoint.ok) {
		output.writeWarn(endpoint.error)
		process.exitCode = endpoint.exitCode
		return null
	}

	const targets = await loadChromeTargets(endpoint, output)
	if (!targets) return null

	const selection = await selectTargetFromCandidates(findTargetsByAttached(status.target, targets), output, {
		interactive: process.stdin.isTTY === true,
		messages: {
			empty: 'No targets matched the attached page.',
			ambiguous: 'Multiple targets matched the attached page.',
		},
	})
	if (!selection.ok) {
		output.writeWarn(selection.error)
		process.exitCode = selection.exitCode
		return null
	}

	return selection.target
}

type ReloadContext = {
	hasParamFlag: boolean
	hasParamsFlag: boolean
	options: PageReloadOptions
	output: ReturnType<typeof createOutput>
}

const reloadTarget = async (target: ChromeTargetResponse, context: ReloadContext): Promise<void> => {
	const { options, output } = context

	if (!target.webSocketDebuggerUrl) {
		output.writeWarn(`Target ${target.id} has no webSocketDebuggerUrl.`)
		process.exitCode = 1
		return
	}

	if (!context.hasParamFlag && !context.hasParamsFlag) {
		try {
			await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.reload' })
		} catch (error) {
			output.writeWarn(`Failed to reload target ${target.id}: ${formatError(error)}`)
			process.exitCode = 1
			return
		}

		if (options.json) {
			output.writeJson({ reloaded: target.id, url: target.url })
		} else {
			output.writeHuman(`reloaded ${target.id}`)
		}
		return
	}

	if (!target.url || target.url.trim() === '') {
		output.writeWarn(`Target ${target.id} has no URL.`)
		process.exitCode = 2
		return
	}

	if (!isHttpUrl(target.url)) {
		output.writeWarn(`Target URL "${target.url}" is not http/https. Cannot update query params.`)
		process.exitCode = 2
		return
	}

	let parsedUrl: URL
	try {
		parsedUrl = new URL(target.url)
	} catch (error) {
		output.writeWarn(`Invalid target URL "${target.url}": ${formatError(error)}`)
		process.exitCode = 2
		return
	}

	const previousUrl = target.url

	if (context.hasParamsFlag) {
		const parsed = parseParamsString(options.params!)
		if ('error' in parsed) {
			output.writeWarn(parsed.error)
			process.exitCode = 2
			return
		}
		for (const [key, value] of parsed.entries()) {
			parsedUrl.searchParams.set(key, value)
		}
	}

	if (context.hasParamFlag) {
		for (const paramPair of options.param!) {
			const parsed = parseParamPair(paramPair)
			if ('error' in parsed) {
				output.writeWarn(parsed.error)
				process.exitCode = 2
				return
			}
			parsedUrl.searchParams.set(parsed.key, parsed.value)
		}
	}

	const nextUrl = parsedUrl.toString()

	try {
		await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.navigate', params: { url: nextUrl } })
	} catch (error) {
		output.writeWarn(`Failed to navigate target ${target.id}: ${formatError(error)}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ reloaded: target.id, url: nextUrl, previousUrl })
	} else {
		output.writeHuman(`reloaded ${target.id} ${nextUrl}`)
	}
}

const findTargetsByAttached = (attached: { title: string | null; url: string | null }, targets: ChromeTargetResponse[]): ChromeTargetResponse[] => {
	if (attached.url) {
		const urlMatches = targets.filter((target) => target.url === attached.url)
		if (urlMatches.length > 0) {
			return urlMatches
		}
	}

	if (attached.title) {
		return targets.filter((target) => target.title === attached.title)
	}

	return []
}
