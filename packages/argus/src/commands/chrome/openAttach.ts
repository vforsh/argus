import type { WatcherHandle } from '@vforsh/argus-watcher'
import type { ChromeTargetResponse } from '../../cdp/types.js'
import type { Output } from '../../output/io.js'
import { registerTerminationHandlers, waitForever } from '../startShared.js'
import { startManagedWatcher } from '../watcherSession.js'

/** Extra flags `page open` accepts to also attach a watcher to the new tab. */
export type ChromeOpenAttachOptions = {
	attach?: boolean
	as?: string
	pageIndicator?: boolean
	artifacts?: string
	json?: boolean
}

/** How long to wait for the watcher to report it attached before giving up. */
const ATTACH_TIMEOUT_MS = 15_000

/**
 * Attach a watcher to a tab `page open` just created, then stay alive to serve it.
 *
 * Matched by the new tab's `targetId`, never by URL: the tab that was just opened is known
 * exactly, and a URL match would happily pick a different tab showing the same page. This is
 * the same in-process watcher `argus start` runs, so the command blocks until Ctrl+C — that is
 * what it means to own a watcher rather than to talk to one.
 *
 * @returns `false` when the watcher failed to start or attach; the caller has already been told.
 */
export const openAndAttachWatcher = async (
	target: ChromeTargetResponse,
	endpoint: { host: string; port: number },
	options: ChromeOpenAttachOptions,
	output: Output,
): Promise<boolean> => {
	const watcherId = options.as!.trim()

	const started = await startManagedWatcher({
		output,
		watcherId,
		source: 'cdp',
		match: { targetId: target.id },
		chrome: endpoint,
		pageIndicator: options.pageIndicator,
		artifacts: options.artifacts,
	})
	if (!started) return false

	const { handle } = started
	registerTerminationHandlers(async () => {
		try {
			await handle.close()
		} catch {}
	})

	const attached = await waitForAttach(handle.events, ATTACH_TIMEOUT_MS)
	if (!attached) {
		output.writeWarn(`Watcher ${watcherId} did not attach to ${target.id} within ${ATTACH_TIMEOUT_MS}ms.`)
		process.exitCode = 1
		await handle.close()
		return false
	}

	if (options.json) {
		output.writeJson({
			...target,
			watcher: { id: handle.watcher.id, host: handle.watcher.host, port: handle.watcher.port, pid: handle.watcher.pid },
		})
	} else {
		output.writeHuman(`${target.id} ${target.url}`)
		output.writeHuman(`watcher ${handle.watcher.id} attached (port=${handle.watcher.port}). Press Ctrl+C to stop.`)
	}

	await waitForever()
	return true
}

/** Resolve once the watcher emits `cdpAttached`, or `false` when the budget runs out. */
const waitForAttach = (events: WatcherHandle['events'], timeoutMs: number): Promise<boolean> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => {
			off()
			resolve(false)
		}, timeoutMs)

		const off = events.on('cdpAttached', () => {
			clearTimeout(timer)
			off()
			resolve(true)
		})
	})
