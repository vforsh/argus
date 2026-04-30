import type { DialogHandleResponse, DialogStatusResponse } from '@vforsh/argus-core'
import { defineWatcherCommand, type WatcherCommandContext, type WatcherRequestPlan } from '../cli/defineWatcherCommand.js'

/** Shared JSON output flag for dialog commands. */
export type DialogCommandOptions = {
	json?: boolean
}

type DialogHandleBody = {
	action: 'accept' | 'dismiss'
	promptText?: string
}

/** Execute `argus dialog status`. */
export const runDialogStatus = defineWatcherCommand<DialogCommandOptions, DialogStatusResponse>({
	build: () => ({ path: '/dialog', timeoutMs: 2_000 }),
	formatHuman: ({ dialog }, { output, watcher }) => {
		if (!dialog) {
			output.writeHuman(`no active dialog on ${watcher.id}`)
			return
		}
		for (const line of formatDialogLines(watcher.id, dialog)) {
			output.writeHuman(line)
		}
	},
})

/** Execute `argus dialog accept`. */
export const runDialogAccept = defineWatcherCommand<DialogCommandOptions, DialogHandleResponse>({
	build: () => buildDialogHandlePlan({ action: 'accept' }),
	formatHuman: formatDialogHandle,
})

/** Execute `argus dialog dismiss`. */
export const runDialogDismiss = defineWatcherCommand<DialogCommandOptions, DialogHandleResponse>({
	build: () => buildDialogHandlePlan({ action: 'dismiss' }),
	formatHuman: formatDialogHandle,
})

/** Execute `argus dialog prompt`. The prompt text is passed as a positional CLI argument. */
export const runDialogPrompt = defineWatcherCommand<DialogCommandOptions, DialogHandleResponse, unknown, [text: string]>({
	build: ([text]) => buildDialogHandlePlan({ action: 'accept', promptText: text }),
	formatHuman: formatDialogHandle,
})

const buildDialogHandlePlan = (body: DialogHandleBody): WatcherRequestPlan => ({
	path: '/dialog',
	method: 'POST',
	body,
	timeoutMs: 5_000,
})

function formatDialogHandle(
	response: DialogHandleResponse,
	{ output, watcher }: WatcherCommandContext<readonly unknown[], DialogCommandOptions>,
): void {
	const verb = response.action === 'accept' ? 'accepted' : 'dismissed'
	output.writeHuman(`${verb} ${response.dialog.type} on ${watcher.id}`)
}

const formatDialogLines = (watcherId: string, dialog: NonNullable<DialogStatusResponse['dialog']>): string[] => {
	const lines = [`${dialog.type} dialog on ${watcherId}`, `message: ${dialog.message}`]

	if (dialog.defaultPrompt != null) {
		lines.push(`default: ${dialog.defaultPrompt}`)
	}
	if (dialog.url) {
		lines.push(`url: ${dialog.url}`)
	}
	if (dialog.hasBrowserHandler) {
		lines.push('browser handler: yes')
	}

	return lines
}
