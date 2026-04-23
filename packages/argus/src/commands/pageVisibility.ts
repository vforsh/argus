import type { VisibilityResponse } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'

/** Shared flags for `argus page show` / `argus page hide`. */
export type PageVisibilityOptions = { json?: boolean }

type PageVisibilityAction = 'show' | 'hide'

/** `argus page show <id>` — lock the page into shown+focused state. */
export const runPageShow = async (id: string | undefined, options: PageVisibilityOptions): Promise<void> => {
	await runPageVisibility(id, 'show', options)
}

/** `argus page hide <id>` — release the visibility lock. */
export const runPageHide = async (id: string | undefined, options: PageVisibilityOptions): Promise<void> => {
	await runPageVisibility(id, 'hide', options)
}

const runPageVisibility = async (id: string | undefined, action: PageVisibilityAction, options: PageVisibilityOptions): Promise<void> => {
	const output = createOutput(options)

	const result = await requestWatcherAction<VisibilityResponse>(
		{
			id,
			path: '/visibility',
			method: 'POST',
			body: { action },
			timeoutMs: 5_000,
		},
		output,
	)

	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	writeHumanResult(output, result.watcher.id, action, result.data)
}

const writeHumanResult = (output: Output, watcherId: string, action: PageVisibilityAction, data: VisibilityResponse): void => {
	if (data.error) {
		output.writeWarn(`page ${action} on ${watcherId} failed: ${data.error.message}`)
		process.exitCode = 1
		return
	}

	if (!data.attached) {
		// Desired state is remembered in the watcher; it will apply on reattach.
		const suffix = action === 'show' ? ' (will apply on reattach)' : ''
		output.writeHuman(`page ${action} queued for ${watcherId}${suffix}`)
		return
	}

	output.writeHuman(`${data.state === 'shown' ? 'shown' : 'hidden'} ${watcherId}`)
}
