import type { DialogHandleResponse, DialogStatusResponse } from '@vforsh/argus-core'
import { createOutput } from '../output/io.js'
import { requestWatcherAction } from '../watchers/requestWatcher.js'

/** Shared JSON output flag for dialog commands. */
export type DialogCommandOptions = {
	json?: boolean
}

/** Execute `argus dialog status`. */
export const runDialogStatus = async (id: string | undefined, options: DialogCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const result = await requestWatcherAction<DialogStatusResponse>(
		{
			id,
			path: '/dialog',
			timeoutMs: 2_000,
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

	const { dialog } = result.data
	if (!dialog) {
		output.writeHuman(`no active dialog on ${result.watcher.id}`)
		return
	}

	for (const line of formatDialogLines(result.watcher.id, dialog)) {
		output.writeHuman(line)
	}
}

/** Execute `argus dialog accept`. */
export const runDialogAccept = async (id: string | undefined, options: DialogCommandOptions): Promise<void> => {
	await runDialogHandle(id, { action: 'accept' }, options)
}

/** Execute `argus dialog dismiss`. */
export const runDialogDismiss = async (id: string | undefined, options: DialogCommandOptions): Promise<void> => {
	await runDialogHandle(id, { action: 'dismiss' }, options)
}

/** Execute `argus dialog prompt`. */
export const runDialogPrompt = async (id: string | undefined, text: string, options: DialogCommandOptions): Promise<void> => {
	await runDialogHandle(id, { action: 'accept', promptText: text }, options)
}

type DialogHandleInput = {
	action: 'accept' | 'dismiss'
	promptText?: string
}

const runDialogHandle = async (id: string | undefined, body: DialogHandleInput, options: DialogCommandOptions): Promise<void> => {
	const output = createOutput(options)
	const result = await requestWatcherAction<DialogHandleResponse>(
		{
			id,
			path: '/dialog',
			method: 'POST',
			body,
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

	const verb = result.data.action === 'accept' ? 'accepted' : 'dismissed'
	output.writeHuman(`${verb} ${result.data.dialog.type} on ${result.watcher.id}`)
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
