import { emitFailure, emitResolveFailure } from './failures.js'
import { createOutput } from '../../output/io.js'
import { resolveWatcher } from '../../watchers/resolveWatcher.js'
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
	_options: ExtensionSelectOptions,
	result: Exclude<ReturnType<typeof resolveExtensionTarget>, { ok: true }>,
): void => {
	const matches = result.matches ?? []
	emitFailure(output, {
		error: result.reason,
		exitCode: result.exitCode,
		hints: matches.map((target) => `  ${formatExtensionTargetLine(target)}`),
		details: { matches },
	})
}

const writeResolveFailure = (
	output: ReturnType<typeof createOutput>,
	_options: ExtensionSelectOptions,
	resolved: Exclude<Awaited<ReturnType<typeof resolveWatcher>>, { ok: true }>,
): void => {
	emitResolveFailure(output, resolved)
}
