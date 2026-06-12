import type { WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatExtensionTabLine } from './tabSelection.js'
import { showWatcher } from './show.js'
import { resolveOrAttachExtensionTabWatcher, writeFailure } from './tabWatcher.js'
import {
	fetchExtensionTargets,
	hasExtensionTargetSelector,
	resolveExtensionTarget,
	selectExtensionTarget,
	waitForSelectedTarget,
} from './targetSelection.js'

export type ExtensionUseOptions = {
	tab?: string | number
	url?: string
	title?: string
	as?: string
	iframe?: string
	iframeUrl?: string
	iframeTitle?: string
	show?: boolean
	json?: boolean
}

export const runExtensionUse = async (options: ExtensionUseOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveOrAttachExtensionTabWatcher(options, output, {
		missingSelectorReason: 'Specify --tab <tabId>, --url <substring>, or --title <substring>.',
	})
	if (!resolved) {
		return
	}

	const selectedTarget = await selectTargetIfRequested(resolved.watcher, options, output)
	if (selectedTarget === false) return

	if (options.show) {
		await showWatcher(resolved.watcher, resolved.tab, output, options)
		return
	}

	if (options.json) {
		output.writeJson({ ok: true, watcherId: resolved.watcher.id, tab: resolved.tab, status: resolved.status, selectedTarget })
		return
	}

	output.writeHuman(resolved.watcher.id)
	output.writeHuman(`  ${formatExtensionTabLine(resolved.tab)}`)
	if (selectedTarget) {
		output.writeHuman(`  selected ${selectedTarget.id} ${selectedTarget.title || selectedTarget.url}`)
	}
}

const selectTargetIfRequested = async (watcher: WatcherRecord, options: ExtensionUseOptions, output: ReturnType<typeof createOutput>) => {
	if (!hasExtensionTargetSelector(options)) {
		return null
	}

	const targets = await fetchExtensionTargets(watcher)
	if (!targets.ok) {
		writeFailure(output, options, targets.error, 1)
		return false
	}

	const target = resolveExtensionTarget(targets.targets, options)
	if (!target.ok) {
		if (options.json) {
			output.writeJson({ ok: false, error: target.reason, matches: target.matches ?? [] })
		} else {
			output.writeWarn(target.reason)
			for (const match of target.matches ?? []) {
				output.writeWarn(`  ${match.id} ${match.title || match.url}`)
			}
		}
		process.exitCode = target.exitCode
		return false
	}

	const selected = await selectExtensionTarget(watcher, target.target)
	if (!selected.ok) {
		writeFailure(output, options, selected.error, 1)
		return false
	}

	const ready = await waitForSelectedTarget(watcher, target.target)
	if (!ready.ok) {
		writeFailure(output, options, ready.error, 1)
		return false
	}

	return ready.target
}
