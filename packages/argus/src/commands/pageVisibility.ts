import type { VisibilityResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

/** Shared flags for `argus page show` / `argus page hide`. */
export type PageVisibilityOptions = { json?: boolean }

type PageVisibilityAction = 'show' | 'hide'

/** Internal runner — the public `runPageShow`/`runPageHide` wrappers thread the action through as a positional arg. */
const visibilityRunner = defineWatcherCommand<PageVisibilityOptions, VisibilityResponse, unknown, [action: PageVisibilityAction]>({
	build: ([action]) => ({
		path: '/visibility',
		method: 'POST',
		body: { action },
		timeoutMs: 5_000,
	}),
	formatHuman: (data, { output, watcher, args: [action] }) => {
		if (!data.attached) {
			// Desired state is remembered in the watcher; it will apply on reattach.
			const suffix = action === 'show' ? ' (will apply on reattach)' : ''
			output.writeHuman(`page ${action} queued for ${watcher.id}${suffix}`)
			return
		}
		output.writeHuman(`${data.state === 'shown' ? 'shown' : 'hidden'} ${watcher.id}`)
	},
})

/** `argus page show <id>` — lock the page into shown+focused state. */
export const runPageShow = (id: string | undefined, options: PageVisibilityOptions): Promise<void> => visibilityRunner(id, 'show', options)

/** `argus page hide <id>` — release the visibility lock. */
export const runPageHide = (id: string | undefined, options: PageVisibilityOptions): Promise<void> => visibilityRunner(id, 'hide', options)
