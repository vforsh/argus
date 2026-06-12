import type { ErrorResponse, ExtensionTabActionResponse, StatusResponse, WatcherRecord } from '@vforsh/argus-core'
import { fetchWatcherJson } from '../../watchers/requestWatcher.js'

export type ExtensionTarget = {
	id: string
	title: string
	url: string
	type?: string
	parentId?: string | null
	faviconUrl?: string
	attached?: boolean
}

export type ExtensionTargetSelectorOptions = {
	iframe?: string
	iframeUrl?: string
	iframeTitle?: string
	page?: boolean
}

export type ExtensionTargetSelectionResult =
	| { ok: true; target: ExtensionTarget }
	| { ok: false; reason: string; exitCode: 2; matches?: ExtensionTarget[] }

export type ExtensionTargetsResponse = {
	ok: true
	targets: ExtensionTarget[]
}

const PLUMBING_IFRAME_PATTERN = /(?:^|[./_-])(q_frame|auth|oauth|login|bridge|analytics|doubleclick|adservice|ads?)(?:[./_-]|$)/i

export const fetchExtensionTargets = async (
	watcher: WatcherRecord,
): Promise<{ ok: true; targets: ExtensionTarget[] } | { ok: false; error: string }> => {
	try {
		const response = await fetchWatcherJson<ExtensionTargetsResponse | ErrorResponse>(watcher, {
			path: '/targets',
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			return { ok: false, error: `Error: ${response.error.message}` }
		}
		return { ok: true, targets: response.targets }
	} catch (error) {
		return { ok: false, error: `${watcher.id}: failed to list extension targets (${formatError(error)})` }
	}
}

export const selectExtensionTarget = async (
	watcher: WatcherRecord,
	target: ExtensionTarget,
): Promise<{ ok: true; tab: ExtensionTabActionResponse['tab']; watcherId?: string } | { ok: false; error: string }> => {
	try {
		const response = await fetchWatcherJson<ExtensionTabActionResponse | ErrorResponse>(watcher, {
			path: '/attach',
			method: 'POST',
			body: { targetId: target.id },
			timeoutMs: 5_000,
			returnErrorResponse: true,
		})
		if (!response.ok) {
			return { ok: false, error: `Error: ${response.error.message}` }
		}
		return { ok: true, tab: response.tab, watcherId: response.watcherId }
	} catch (error) {
		return { ok: false, error: `${watcher.id}: failed to select target (${formatError(error)})` }
	}
}

export const waitForSelectedTarget = async (
	watcher: WatcherRecord,
	target: ExtensionTarget,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ ok: true; status: StatusResponse; target: ExtensionTarget } | { ok: false; error: string }> => {
	const timeoutMs = options.timeoutMs ?? 5_000
	const intervalMs = options.intervalMs ?? 200
	const startedAt = Date.now()
	let lastError = `Target ${target.id} was not selected before timeout.`

	while (Date.now() - startedAt <= timeoutMs) {
		const [status, targets] = await Promise.all([fetchWatcherStatus(watcher), fetchExtensionTargets(watcher)])
		if (!status.ok) {
			lastError = status.error
			await delay(intervalMs)
			continue
		}
		if (!targets.ok) {
			lastError = targets.error
			await delay(intervalMs)
			continue
		}

		const selected = targets.targets.find((entry) => entry.id === target.id && entry.attached === true)
		if (selected && statusMatchesTarget(status.status, selected) && status.status.targetReady !== false) {
			return { ok: true, status: status.status, target: selected }
		}

		await delay(intervalMs)
	}

	return { ok: false, error: lastError }
}

export const resolveExtensionTarget = (targets: ExtensionTarget[], options: ExtensionTargetSelectorOptions): ExtensionTargetSelectionResult => {
	const selectorCount = [options.page === true, Boolean(options.iframe), Boolean(options.iframeUrl), Boolean(options.iframeTitle)].filter(
		Boolean,
	).length
	if (selectorCount !== 1) {
		return { ok: false, reason: 'Specify exactly one of --page, --iframe auto, --iframe-url, or --iframe-title.', exitCode: 2 }
	}

	if (options.page) {
		const page = targets.find((target) => target.type === 'page' || target.id.startsWith('tab:'))
		return page ? { ok: true, target: page } : { ok: false, reason: 'No page target found.', exitCode: 2 }
	}

	const iframeTargets = targets.filter((target) => target.type === 'iframe')
	if (options.iframeUrl) {
		return resolveSingleMatch(iframeTargets, (target) => includesIgnoreCase(target.url, options.iframeUrl!), 'iframe URL')
	}
	if (options.iframeTitle) {
		return resolveSingleMatch(iframeTargets, (target) => includesIgnoreCase(target.title, options.iframeTitle!), 'iframe title')
	}
	if (options.iframe !== 'auto') {
		return { ok: false, reason: '--iframe currently supports only "auto".', exitCode: 2 }
	}

	return resolveAutoIframe(iframeTargets, targets)
}

export const hasExtensionTargetSelector = (options: ExtensionTargetSelectorOptions): boolean =>
	Boolean(options.page === true || options.iframe || options.iframeUrl || options.iframeTitle)

export const formatExtensionTargetLine = (target: ExtensionTarget): string => {
	const state = target.attached ? 'attached' : 'available'
	const type = target.type ?? 'target'
	const title = target.title || '(untitled)'
	const parent = target.parentId ? ` [parent: ${shortenId(target.parentId)}]` : ''
	return `${target.id} [${state}] ${type} ${title} - ${target.url}${parent}`
}

export const renderExtensionTargetTree = (targets: ExtensionTarget[], output: { writeHuman: (text: string) => void }): void => {
	const targetById = new Map(targets.map((target) => [target.id, target]))
	const childrenByParent = new Map<string | null, ExtensionTarget[]>()

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

	roots.forEach((root, index) => {
		renderTargetNode(root, '', index === roots.length - 1, childrenByParent, output, true)
	})
}

const resolveSingleMatch = (
	targets: ExtensionTarget[],
	predicate: (target: ExtensionTarget) => boolean,
	label: string,
): ExtensionTargetSelectionResult => {
	const matches = targets.filter(predicate)
	if (matches.length === 0) {
		return { ok: false, reason: `No ${label} matched.`, exitCode: 2 }
	}
	if (matches.length > 1) {
		return { ok: false, reason: `Multiple ${label} targets matched. Narrow the selector.`, exitCode: 2, matches }
	}
	return { ok: true, target: matches[0] }
}

const resolveAutoIframe = (iframes: ExtensionTarget[], allTargets: ExtensionTarget[]): ExtensionTargetSelectionResult => {
	if (iframes.length === 0) {
		return { ok: false, reason: 'No iframe targets found.', exitCode: 2 }
	}

	const page = allTargets.find((target) => target.type === 'page' || target.id.startsWith('tab:'))
	const scored = iframes.map((target) => ({ target, score: scoreIframeTarget(target, page) })).sort((left, right) => right.score - left.score)

	const [best, second] = scored
	if (!best) {
		return { ok: false, reason: 'No iframe targets found.', exitCode: 2 }
	}
	if (second && second.score === best.score) {
		return {
			ok: false,
			reason: 'Multiple iframe targets look equally likely. Use --iframe-url or --iframe-title.',
			exitCode: 2,
			matches: scored.filter((entry) => entry.score === best.score).map((entry) => entry.target),
		}
	}
	return { ok: true, target: best.target }
}

const scoreIframeTarget = (target: ExtensionTarget, page: ExtensionTarget | undefined): number => {
	let score = 0
	// Auto mode is a conservative convenience for wrapper pages: prefer app-like
	// cross-origin iframes and penalize known browser/platform plumbing.
	if (originOf(target.url) && originOf(target.url) !== originOf(page?.url)) {
		score += 4
	}
	if (target.title && target.title !== target.url && !target.title.startsWith('http')) {
		score += 3
	}
	if (target.attached) {
		score += 1
	}
	if (PLUMBING_IFRAME_PATTERN.test(`${target.url} ${target.title}`)) {
		score -= 10
	}
	return score
}

const renderTargetNode = (
	target: ExtensionTarget,
	prefix: string,
	isLast: boolean,
	childrenByParent: Map<string | null, ExtensionTarget[]>,
	output: { writeHuman: (text: string) => void },
	isRoot = false,
): void => {
	const connector = targetTreeConnector(isRoot, isLast)
	const childPrefix = targetTreeChildPrefix(prefix, isRoot, isLast)
	const state = target.attached ? ' attached' : ''
	output.writeHuman(`${prefix}${connector}${target.title || '(untitled)'} (${target.type ?? 'target'}, ${shortenId(target.id)}${state})`)
	output.writeHuman(`${childPrefix}${target.url}`)

	const children = childrenByParent.get(target.id) ?? []
	children.forEach((child, index) => {
		renderTargetNode(child, childPrefix, index === children.length - 1, childrenByParent, output)
	})
}

const targetTreeConnector = (isRoot: boolean, isLast: boolean): string => {
	if (isRoot) return ''
	return isLast ? '└── ' : '├── '
}

const targetTreeChildPrefix = (prefix: string, isRoot: boolean, isLast: boolean): string => {
	if (isRoot) return ''
	return prefix + (isLast ? '    ' : '│   ')
}

const fetchWatcherStatus = async (watcher: WatcherRecord): Promise<{ ok: true; status: StatusResponse } | { ok: false; error: string }> => {
	try {
		return { ok: true, status: await fetchWatcherJson<StatusResponse>(watcher, { path: '/status', timeoutMs: 1_000 }) }
	} catch (error) {
		return { ok: false, error: `${watcher.id}: failed to read status (${formatError(error)})` }
	}
}

const statusMatchesTarget = (status: StatusResponse, target: ExtensionTarget): boolean => {
	if (!status.attached || !status.target) {
		return false
	}
	if (status.target.url && status.target.url === target.url) {
		return true
	}
	return Boolean(status.target.title && status.target.title === target.title && status.target.url === target.url)
}

const includesIgnoreCase = (value: string, needle: string): boolean => value.toLowerCase().includes(needle.toLowerCase())

const originOf = (url: string | undefined): string | null => {
	if (!url) {
		return null
	}
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

const shortenId = (id: string): string => (id.length > 18 ? `${id.slice(0, 14)}...` : id)

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
