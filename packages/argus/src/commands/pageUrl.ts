import type { StatusResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'

/** Options for `argus page url`. */
export type PageUrlOptions = { json?: boolean }

/**
 * `argus page url [id]` — print the attached page's URL.
 *
 * Human output is the bare URL and nothing else, so it pipes: `open "$(argus page url app)"`.
 * Backed by `GET /status` rather than an endpoint of its own — the watcher already reports the
 * authoritative URL there, and a second source of truth is exactly what this replaces
 * (`argus eval app "location.href"`, which needs a live execution context and returns the
 * *selected frame's* URL, not the page's).
 */
export const runPageUrl = defineWatcherCommand<PageUrlOptions, StatusResponse>({
	build: () => ({ path: '/status', method: 'GET', timeoutMs: 5_000 }),
	formatJson: (status) => ({
		url: status.target?.url ?? null,
		title: status.target?.title ?? null,
		attached: status.attached,
	}),
	formatHuman: (status, { output, watcher }) => {
		if (!status.attached || !status.target?.url) {
			output.writeWarn(`Watcher ${watcher.id} is not attached to a page.`)
			process.exitCode = 1
			return
		}
		output.writeHuman(status.target.url)
	},
})
