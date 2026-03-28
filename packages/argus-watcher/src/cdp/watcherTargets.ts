import type { WatcherChrome, WatcherMatch } from '@vforsh/argus-core'

/** Minimal CDP target metadata needed for attachment. */
export type CdpTarget = {
	/** CDP target id (from Chrome `/json` endpoint). */
	id: string

	/** Human-readable page title for the target. */
	title: string

	/** Page URL for the target. */
	url: string

	/** WebSocket URL used to connect to the target via the Chrome DevTools Protocol. */
	webSocketDebuggerUrl: string

	/** Target type (e.g., 'page', 'iframe', 'worker', 'service_worker'). */
	type: string

	/** Parent target ID for nested targets (e.g., iframes within pages). Null for top-level pages. */
	parentId: string | null
}

export const findTarget = async (chrome: WatcherChrome, match?: WatcherMatch): Promise<CdpTarget> => {
	const targets = await fetchTargets(chrome)
	if (targets.length === 0) {
		throw new Error('No CDP targets available')
	}

	if (match?.targetId) {
		const selected = targets.find((target) => target.id === match.targetId)
		if (!selected) {
			throw new Error(`No CDP target found with id: ${match.targetId}`)
		}
		return selected
	}

	const hasFilters = match?.url || match?.title || match?.urlRegex || match?.titleRegex || match?.type || match?.origin || match?.parent
	if (!match || !hasFilters) {
		return targets[0]
	}

	const urlRegex = match.urlRegex ? safeRegex(match.urlRegex) : null
	const titleRegex = match.titleRegex ? safeRegex(match.titleRegex) : null
	const targetById = new Map(targets.map((target) => [target.id, target]))

	const selected = targets.find((target) => matchesTarget(target, match, targetById, urlRegex, titleRegex))
	if (!selected) {
		throw new Error('No CDP target matched the provided criteria')
	}

	return selected
}

const matchesTarget = (
	target: CdpTarget,
	match: WatcherMatch,
	targetById: Map<string, CdpTarget>,
	urlRegex: RegExp | null,
	titleRegex: RegExp | null,
): boolean => {
	if (match.type && target.type !== match.type) {
		return false
	}

	if (match.origin) {
		const targetOrigin = extractOrigin(target.url)
		if (!targetOrigin || !targetOrigin.includes(match.origin)) {
			return false
		}
	}

	if (match.parent) {
		if (!target.parentId) {
			return false
		}
		const parent = targetById.get(target.parentId)
		if (!parent || !parent.url.includes(match.parent)) {
			return false
		}
	}

	if (match.url && !target.url.includes(match.url)) {
		return false
	}

	if (match.title && !target.title.includes(match.title)) {
		return false
	}

	if (urlRegex && !urlRegex.test(target.url)) {
		return false
	}

	if (titleRegex && !titleRegex.test(target.title)) {
		return false
	}

	return true
}

const fetchTargets = async (chrome: WatcherChrome): Promise<CdpTarget[]> => {
	const response = await fetch(`http://${chrome.host}:${chrome.port}/json`)
	if (!response.ok) {
		throw new Error(`Failed to fetch CDP targets (status ${response.status})`)
	}

	const data = await response.json()
	if (!Array.isArray(data)) {
		throw new Error('CDP target list is not an array')
	}

	return data
		.map((target) => ({
			id: target.id as string,
			title: String(target.title ?? ''),
			url: String(target.url ?? ''),
			webSocketDebuggerUrl: String(target.webSocketDebuggerUrl ?? ''),
			type: String(target.type ?? 'page'),
			parentId: typeof target.parentId === 'string' ? target.parentId : null,
		}))
		.filter((target) => Boolean(target.webSocketDebuggerUrl))
}

const extractOrigin = (url: string): string | null => {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

const safeRegex = (pattern: string): RegExp => {
	try {
		return new RegExp(pattern)
	} catch {
		throw new Error(`Invalid regex pattern: ${pattern}`)
	}
}
