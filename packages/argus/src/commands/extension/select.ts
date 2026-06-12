import { createOutput } from '../../output/io.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
import { formatWatcherLine } from '../../output/format.js'
import { writeFailure } from './tabWatcher.js'
import {
	fetchExtensionTargets,
	formatExtensionTargetLine,
	resolveExtensionTarget,
	selectExtensionTarget,
	waitForSelectedTarget,
	type ExtensionTargetSelectorOptions,
} from './targetSelection.js'

export type ExtensionSelectOptions = ExtensionTargetSelectorOptions & {
	wait?: boolean
	json?: boolean
}

export const runExtensionSelect = async (id: string | undefined, options: ExtensionSelectOptions): Promise<void> => {
	const output = createOutput(options)
	if (!id) {
		writeFailure(output, options, 'Specify an extension watcher id.', 2)
		return
	}

	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) {
		writeResolveFailure(output, options, resolved)
		return
	}
	if (resolved.watcher.source !== 'extension') {
		writeFailure(output, options, `Watcher ${resolved.watcher.id} is not extension-backed.`, 2)
		return
	}

	const targets = await fetchExtensionTargets(resolved.watcher)
	if (!targets.ok) {
		writeFailure(output, options, targets.error, 1)
		return
	}

	const target = resolveExtensionTarget(targets.targets, options)
	if (!target.ok) {
		writeTargetFailure(output, options, target)
		return
	}

	const selected = await selectExtensionTarget(resolved.watcher, target.target)
	if (!selected.ok) {
		writeFailure(output, options, selected.error, 1)
		return
	}

	const ready = options.wait === false ? null : await waitForSelectedTarget(resolved.watcher, target.target)
	if (ready && !ready.ok) {
		writeFailure(output, options, ready.error, 1)
		return
	}

	const selectedTarget = ready?.target ?? target.target
	if (options.json) {
		output.writeJson({ ok: true, watcherId: resolved.watcher.id, target: selectedTarget, status: ready?.status ?? null, tab: selected.tab })
		return
	}

	output.writeHuman(`selected ${selectedTarget.id} on ${resolved.watcher.id}`)
	output.writeHuman(`  ${formatExtensionTargetLine(selectedTarget)}`)
}

const writeTargetFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionSelectOptions,
	result: Exclude<ReturnType<typeof resolveExtensionTarget>, { ok: true }>,
): void => {
	if (options.json) {
		output.writeJson({ ok: false, error: result.reason, matches: result.matches ?? [] })
	} else {
		output.writeWarn(result.reason)
		for (const target of result.matches ?? []) {
			output.writeWarn(`  ${formatExtensionTargetLine(target)}`)
		}
	}
	process.exitCode = result.exitCode
}

const writeResolveFailure = (
	output: ReturnType<typeof createOutput>,
	options: ExtensionSelectOptions,
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
