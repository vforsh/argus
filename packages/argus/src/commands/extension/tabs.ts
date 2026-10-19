import type { ExtensionBrowserTab } from '@vforsh/argus-core'
import { formatExtensionTabLine } from './tabSelection.js'
import { emitFailure, emitResolveFailure } from './failures.js'
import { createOutput } from '../../output/io.js'
import { formatBrowserGroupName, resolveControlTabs } from './browserTabs.js'

export type ExtensionTabsOptions = {
	id?: string
	/** Browser label or instance id; alternative to `id`. */
	browser?: string
	url?: string
	title?: string
	json?: boolean
}

/**
 * List extension tabs. With several live browsers and no `--id`/`--browser`, a `--url`/`--title`
 * filter that matches in one browser lists that browser; otherwise every browser's tabs are listed,
 * grouped by control watcher, instead of failing with `ambiguous_control`.
 */
export const runExtensionTabs = async (options: ExtensionTabsOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveControlTabs(options, { kind: 'query', url: options.url?.trim() || undefined, title: options.title?.trim() || undefined })

	if (resolved.kind === 'failed') {
		emitResolveFailure(output, resolved.failure)
		return
	}

	if (resolved.kind === 'single') {
		if (resolved.fetchFailure) {
			emitFailure(output, { error: resolved.fetchFailure.response ?? resolved.fetchFailure.error })
			return
		}
		for (const warning of resolved.warnings) output.writeWarn(warning)
		if (options.json) {
			output.writeJson({ viaWatcherId: resolved.watcher.id, tabs: resolved.tabs })
			return
		}
		output.writeHuman(`Extension tabs via ${resolved.watcher.id}`)
		writeTabLines(output, resolved.tabs)
		return
	}

	// Every browser failing is a failure, even though the listing itself still renders.
	if (resolved.groups.every((group) => group.error)) {
		process.exitCode = 1
	}

	if (options.json) {
		output.writeJson({
			viaWatcherId: null,
			tabs: resolved.groups.flatMap((group) => group.tabs.map((tab) => ({ ...tab, controlId: group.control.id }))),
			browsers: resolved.groups.map((group) => ({
				controlId: group.control.id,
				label: group.label,
				tabs: group.tabs,
				...(group.error ? { error: group.error } : {}),
			})),
		})
		return
	}

	resolved.groups.forEach((group, index) => {
		if (index > 0) output.writeHuman('')
		output.writeHuman(`Extension tabs via ${formatBrowserGroupName(group)}`)
		if (group.error) {
			output.writeHuman(`  (failed: ${group.error})`)
			return
		}
		writeTabLines(output, group.tabs)
	})
}

const writeTabLines = (output: ReturnType<typeof createOutput>, tabs: readonly ExtensionBrowserTab[]): void => {
	if (tabs.length === 0) {
		output.writeHuman('  (none)')
		return
	}
	for (const tab of tabs) {
		output.writeHuman(`  ${formatExtensionTabLine(tab)}`)
	}
}
