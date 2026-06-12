import type { WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { formatWatcherLine } from '../../output/format.js'
import { hasTabSelector } from './tabSelection.js'
import { resolveOrAttachExtensionTabWatcher, writeFailure, type ExtensionTabWatcherOptions } from './tabWatcher.js'
import { fetchExtensionTargets, formatExtensionTargetLine, renderExtensionTargetTree, type ExtensionTarget } from './targetSelection.js'

export type ExtensionTargetsOptions = ExtensionTabWatcherOptions & {
	type?: string
	tree?: boolean
}

export const runExtensionTargets = async (id: string | undefined, options: ExtensionTargetsOptions): Promise<void> => {
	const output = createOutput(options)

	if (id && hasTabSelector(options)) {
		writeFailure(output, options, 'Use either watcher id or --tab/--url/--title, not both.', 2)
		return
	}

	const resolved = id
		? await resolveExistingExtensionWatcher(id, options)
		: await resolveOrAttachExtensionTabWatcher(options, output, {
				missingSelectorReason: 'Specify a watcher id, --tab <tabId>, --url <substring>, or --title <substring>.',
			})
	if (!resolved) {
		return
	}

	const targets = await fetchExtensionTargets(resolved.watcher)
	if (!targets.ok) {
		writeFailure(output, options, targets.error, 1)
		return
	}

	const filteredTargets = filterTargets(targets.targets, options.type)
	if (options.json) {
		output.writeJson({ ok: true, watcherId: resolved.watcher.id, tab: resolved.tab, targets: filteredTargets })
		return
	}

	output.writeHuman(`Extension targets via ${resolved.watcher.id}`)
	if (filteredTargets.length === 0) {
		output.writeHuman('  (none)')
		return
	}

	if (options.tree) {
		renderExtensionTargetTree(filteredTargets, output)
		return
	}

	for (const target of filteredTargets) {
		output.writeHuman(`  ${formatExtensionTargetLine(target)}`)
	}
}

const resolveExistingExtensionWatcher = async (
	id: string,
	options: ExtensionTargetsOptions,
): Promise<{ watcher: WatcherRecord; tab: null } | null> => {
	const output = createOutput(options)
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		writeResolveFailure(output, options, resolved)
		return null
	}
	if (resolved.watcher.source !== 'extension') {
		writeFailure(output, options, `Watcher ${resolved.watcher.id} is not extension-backed.`, 2)
		return null
	}
	return { watcher: resolved.watcher, tab: null }
}

const filterTargets = (targets: ExtensionTarget[], type?: string): ExtensionTarget[] => {
	const targetType = type?.trim()
	return targetType ? targets.filter((target) => target.type === targetType) : targets
}

const writeResolveFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionTargetsOptions,
	resolved: Exclude<Awaited<ReturnType<typeof resolveWatcher>>, { ok: true }>,
): void => {
	if (options.json) {
		output.writeJson({ ok: false, error: resolved.error, candidates: resolved.candidates?.map((watcher) => watcher.id) ?? [] })
	} else {
		output.writeWarn(resolved.error)
		for (const watcher of resolved.candidates ?? []) {
			output.writeWarn(formatWatcherLine(watcher))
		}
	}
	process.exitCode = resolved.exitCode
}
