import type { ChromeTargetResponse } from '../../cdp/types.js'
import { sendCdpCommand } from '../../cdp/sendCdpCommand.js'
import { filterTargets, selectTargetFromCandidates } from '../../cdp/selectTarget.js'
import { fetchJson, fetchText } from '../../httpClient.js'
import { createOutput } from '../../output/io.js'
import type { ChromeCommandOptions } from './shared.js'
import { loadChromeTargets, normalizeUrl, resolveChromeEndpointOrExit, resolveWatcherOrExit } from './shared.js'

export type ChromeTargetsOptions = ChromeCommandOptions & {
	type?: string
	tree?: boolean
}

export type ChromeOpenOptions = ChromeCommandOptions & {
	url: string
}

export type ChromeActivateOptions = ChromeCommandOptions & {
	targetId?: string
	title?: string
	url?: string
	match?: string
}

export type ChromeCloseOptions = ChromeCommandOptions & {
	targetId: string
}

export type ChromeReloadOptions = ChromeCommandOptions & {
	targetId: string
}

export const runChromeTargets = async (options: ChromeTargetsOptions): Promise<void> => {
	const output = createOutput(options)

	if (options.id) {
		const watcher = await resolveWatcherOrExit(options.id, output)
		if (!watcher) {
			return
		}

		if (watcher.source === 'extension') {
			try {
				const response = await fetchJson<{ ok: true; targets: ChromeTargetResponse[] }>(`http://${watcher.host}:${watcher.port}/targets`)
				renderTargets(response.targets, { output, type: options.type, tree: options.tree, json: options.json })
				return
			} catch (error) {
				output.writeWarn(`Failed to load watcher targets from ${watcher.id}: ${error instanceof Error ? error.message : error}`)
				process.exitCode = 1
				return
			}
		}
	}

	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const targets = await loadChromeTargets(endpoint, output)
	if (!targets) {
		return
	}

	renderTargets(targets, { output, type: options.type, tree: options.tree, json: options.json })
}

export const runChromeOpen = async (options: ChromeOpenOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.url || options.url.trim() === '') {
		output.writeWarn('--url is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const encodedUrl = encodeURIComponent(normalizeUrl(options.url.trim()))
	try {
		const target = await fetchJson<ChromeTargetResponse>(`http://${endpoint.host}:${endpoint.port}/json/new?${encodedUrl}`, { method: 'PUT' })
		if (options.json) {
			output.writeJson(target)
			return
		}
		output.writeHuman(`${target.id} ${target.url}`)
	} catch (error) {
		output.writeWarn(`Failed to open tab: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
	}
}

export const runChromeActivate = async (options: ChromeActivateOptions): Promise<void> => {
	const output = createOutput(options)
	const targetIdInput = options.targetId?.trim()
	const hasTargetId = Boolean(targetIdInput)
	const hasFilters = Boolean(options.title || options.url || options.match)
	if (hasTargetId && hasFilters) {
		output.writeWarn('Cannot combine targetId with --title/--url/--match.')
		process.exitCode = 2
		return
	}

	if (!hasTargetId && !hasFilters) {
		output.writeWarn('targetId or --title/--url/--match is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	let targetId = targetIdInput
	if (!targetId) {
		const targets = await loadChromeTargets(endpoint, output)
		if (!targets) {
			return
		}

		const candidates = filterTargets(targets, { title: options.title, url: options.url, match: options.match })
		const selection = await selectTargetFromCandidates(candidates, output, {
			interactive: process.stdin.isTTY === true,
			messages: {
				empty: 'No targets matched the provided filters.',
				ambiguous: 'Multiple targets matched. Provide a narrower filter or a targetId.',
			},
		})
		if (!selection.ok) {
			output.writeWarn(selection.error)
			process.exitCode = selection.exitCode
			return
		}

		targetId = selection.target.id
	}

	try {
		await fetchText(`http://${endpoint.host}:${endpoint.port}/json/activate/${targetId}`)
	} catch (error) {
		output.writeWarn(`Failed to activate target: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ activated: targetId })
		return
	}

	output.writeHuman(`activated ${targetId}`)
}

export const runChromeClose = async (options: ChromeCloseOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.targetId || options.targetId.trim() === '') {
		output.writeWarn('targetId is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const targetId = options.targetId.trim()
	try {
		await fetchText(`http://${endpoint.host}:${endpoint.port}/json/close/${targetId}`)
	} catch (error) {
		output.writeWarn(`Failed to close target: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ closed: targetId })
		return
	}

	output.writeHuman(`closed ${targetId}`)
}

export const runChromeReload = async (options: ChromeReloadOptions): Promise<void> => {
	const output = createOutput(options)
	if (!options.targetId || options.targetId.trim() === '') {
		output.writeWarn('targetId is required.')
		process.exitCode = 2
		return
	}

	const endpoint = await resolveChromeEndpointOrExit(options, output)
	if (!endpoint) {
		return
	}

	const targets = await loadChromeTargets(endpoint, output)
	if (!targets) {
		return
	}

	const target = targets.find((entry) => entry.id === options.targetId.trim())
	if (!target) {
		output.writeWarn(`Target not found: ${options.targetId.trim()}`)
		process.exitCode = 2
		return
	}

	if (!target.webSocketDebuggerUrl) {
		output.writeWarn(`Target ${target.id} has no webSocketDebuggerUrl.`)
		process.exitCode = 1
		return
	}

	try {
		await sendCdpCommand(target.webSocketDebuggerUrl, { id: 1, method: 'Page.reload' })
	} catch (error) {
		output.writeWarn(`Failed to reload target ${target.id}: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return
	}

	if (options.json) {
		output.writeJson({ reloaded: target.id, url: target.url })
		return
	}

	output.writeHuman(`reloaded ${target.id}`)
}

const renderTargets = (
	targets: ChromeTargetResponse[],
	options: { output: ReturnType<typeof createOutput>; type?: string; tree?: boolean; json?: boolean },
): void => {
	let filteredTargets = targets
	if (options.type) {
		filteredTargets = filteredTargets.filter((target) => target.type === options.type)
	}

	if (options.json) {
		options.output.writeJson(filteredTargets)
		return
	}

	if (options.tree) {
		renderTargetTree(filteredTargets, options.output)
		return
	}

	for (const target of filteredTargets) {
		const title = target.title ? ` ${target.title}` : ''
		const targetUrl = target.url ? ` ${target.url}` : ''
		const parentInfo = target.parentId ? ` [parent: ${target.parentId.slice(0, 8)}...]` : ''
		options.output.writeHuman(`${target.id} ${target.type}${title}${targetUrl}${parentInfo}`)
	}
}

const renderTargetTree = (targets: ChromeTargetResponse[], output: { writeHuman: (msg: string) => void }): void => {
	const targetById = new Map(targets.map((target) => [target.id, target]))
	const childrenByParent = new Map<string | null, ChromeTargetResponse[]>()

	for (const target of targets) {
		const parentId = target.parentId ?? null
		const children = childrenByParent.get(parentId) ?? []
		children.push(target)
		childrenByParent.set(parentId, children)
	}

	const roots = targets.filter((target) => !target.parentId || !targetById.has(target.parentId))
	if (roots.length === 0) {
		output.writeHuman('(no targets)')
		return
	}

	const renderNode = (target: ChromeTargetResponse, prefix: string, isLast: boolean): void => {
		const connector = isLast ? '└── ' : '├── '
		const title = target.title || '(untitled)'
		const shortId = `${target.id.slice(0, 8)}...`
		output.writeHuman(`${prefix}${connector}${title} (${target.type}, ${shortId})`)
		output.writeHuman(`${prefix}${isLast ? '    ' : '│   '}${target.url}`)

		const children = childrenByParent.get(target.id) ?? []
		children.forEach((child, index) => {
			renderNode(child, prefix + (isLast ? '    ' : '│   '), index === children.length - 1)
		})
	}

	roots.forEach((root, index) => {
		const title = root.title || '(untitled)'
		const shortId = `${root.id.slice(0, 8)}...`
		output.writeHuman(`${title} (${root.type}, ${shortId})`)
		output.writeHuman(root.url)

		const children = childrenByParent.get(root.id) ?? []
		children.forEach((child, childIndex) => {
			renderNode(child, '', childIndex === children.length - 1)
		})

		if (index < roots.length - 1) {
			output.writeHuman('')
		}
	})
}
