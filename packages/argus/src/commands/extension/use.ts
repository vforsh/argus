import { delay, type WatcherRecord } from '@vforsh/argus-core'
import { createOutput } from '../../output/io.js'
import { formatExtensionTabLine } from './tabSelection.js'
import { showWatcher } from './show.js'
import { resolveOrAttachExtensionTabWatcher, writeFailure } from './tabWatcher.js'
import {
	describeExtensionTargetSelectorError,
	fetchExtensionTargets,
	hasExtensionTargetSelector,
	resolveExtensionTarget,
	selectExtensionTarget,
	waitForSelectedTarget,
} from './targetSelection.js'

export type ExtensionUseOptions = {
	id?: string
	browser?: string
	tab?: string | number
	url?: string
	title?: string
	pick?: string
	open?: string
	as?: string
	iframe?: string
	iframeUrl?: string
	iframeTitle?: string
	show?: boolean
	json?: boolean
	/** Full tab, status, and target in `--json` output. */
	verbose?: boolean
}

export const runExtensionUse = async (options: ExtensionUseOptions): Promise<void> => {
	const output = createOutput(options)
	const resolved = await resolveOrAttachExtensionTabWatcher(options, output, {
		missingSelectorReason: 'Specify --tab <tabId>, --url <substring>, --title <substring>, or --open <url>.',
	})
	if (!resolved) {
		return
	}

	// A tab opened just now may not have created its iframe yet; wait for it instead of failing.
	const selectedTarget = await selectTargetIfRequested(resolved.watcher, options, output, resolved.opened ? IFRAME_APPEAR_TIMEOUT_MS : 0)
	if (selectedTarget === false) return

	if (options.show) {
		await showWatcher(resolved.watcher, resolved.tab, output, options)
		return
	}

	if (options.json && options.verbose) {
		output.writeJson({
			ok: true,
			watcherId: resolved.watcher.id,
			controlId: resolved.controlWatcher.id,
			opened: resolved.opened === true,
			tab: resolved.tab,
			status: resolved.status,
			selectedTarget,
		})
		return
	}
	if (options.json) {
		// Essentials only: the full status/tab dump was most of the output and agents cut it with `head`.
		const { tabId, url, title } = resolved.tab
		output.writeJson({
			ok: true,
			watcherId: resolved.watcher.id,
			controlId: resolved.controlWatcher.id,
			tab: { tabId, url, title },
			attached: resolved.status?.attached ?? true,
			targetReady: resolved.status?.targetReady ?? null,
			...(resolved.opened ? { opened: true } : {}),
			...(selectedTarget ? { selectedTarget: { id: selectedTarget.id, type: selectedTarget.type, url: selectedTarget.url } } : {}),
		})
		return
	}

	output.writeHuman(resolved.watcher.id)
	if (resolved.opened) {
		output.writeHuman(`  opened via ${resolved.controlWatcher.id}`)
	}
	output.writeHuman(`  ${formatExtensionTabLine(resolved.tab)}`)
	if (selectedTarget) {
		output.writeHuman(`  selected ${selectedTarget.id} ${selectedTarget.title || selectedTarget.url}`)
	}
}

const IFRAME_APPEAR_TIMEOUT_MS = 15_000
const IFRAME_POLL_INTERVAL_MS = 300
/** `--iframe auto` scores every iframe, so it waits until the set stops changing for this long. */
const IFRAME_SETTLE_MS = 1_500

/**
 * Poll a freshly opened tab's targets until the selector can be decided: `--iframe-url/--iframe-title`
 * until something matches, `--iframe auto` until the iframe set is stable (picking the first frame to
 * load would usually pick host-page plumbing). Malformed selectors return at once.
 */
const waitForTargetsToAppear = async (watcher: WatcherRecord, options: ExtensionUseOptions, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs
	let targets = await fetchExtensionTargets(watcher)
	if (describeExtensionTargetSelectorError(options)) return targets

	let lastKey = ''
	let stableSince = Date.now()
	while (targets.ok && Date.now() < deadline) {
		const iframeKey = targets.targets
			.filter((target) => target.type === 'iframe')
			.map((target) => `${target.id} ${target.url}`)
			.sort()
			.join('|')
		if (iframeKey !== lastKey) {
			lastKey = iframeKey
			stableSince = Date.now()
		}
		const decided = options.iframe === 'auto' ? iframeKey !== '' && Date.now() - stableSince >= IFRAME_SETTLE_MS : resolveExtensionTarget(targets.targets, options).ok
		if (decided) break
		await delay(IFRAME_POLL_INTERVAL_MS)
		targets = await fetchExtensionTargets(watcher)
	}
	return targets
}

const selectTargetIfRequested = async (
	watcher: WatcherRecord,
	options: ExtensionUseOptions,
	output: ReturnType<typeof createOutput>,
	appearTimeoutMs: number,
) => {
	if (!hasExtensionTargetSelector(options)) {
		return null
	}

	const targets = appearTimeoutMs > 0 ? await waitForTargetsToAppear(watcher, options, appearTimeoutMs) : await fetchExtensionTargets(watcher)
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
