import type { DialogStatusResponse } from '@vforsh/argus-core'
import type { Page } from 'playwright'
import type { Cli } from './cli.js'
import { waitFor } from './poll.js'

type PendingDialog = NonNullable<DialogStatusResponse['dialog']>

/** Poll `argus dialog status` until a dialog of `type` is pending, or until none is. */
export const createDialogProbe = (cli: Cli, watcherId: string) => {
	const status = () => cli.json<DialogStatusResponse>(['dialog', 'status', watcherId, '--json'])
	return {
		waitForDialog: async (type: PendingDialog['type']): Promise<PendingDialog> =>
			(await waitFor(status, (current) => current.dialog?.type === type, { timeoutMs: 5_000 })).dialog!,
		waitForNoDialog: async (): Promise<void> => {
			await waitFor(status, (current) => !current.dialog, { timeoutMs: 5_000 })
		},
	}
}

export type HeldDialog = {
	/** What Playwright saw open. */
	dialog: { type: string; message: string; defaultValue: string }
	/** Let Playwright's listener return; Argus settles the dialog itself. */
	release: () => void
}

/**
 * Run `open`, then catch the native dialog it raises and keep Playwright's listener parked, so the
 * dialog stays pending for Argus instead of being auto-dismissed.
 */
export const holdNextDialog = async (page: Page, open: () => Promise<unknown>): Promise<HeldDialog> => {
	let release: () => void = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const opened = new Promise<HeldDialog['dialog']>((resolve) => {
		page.once('dialog', async (dialog) => {
			resolve({ type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() })
			await held
		})
	})
	await open()
	return { dialog: await opened, release: () => release() }
}
