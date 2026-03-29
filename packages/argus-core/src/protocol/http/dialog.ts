/** Browser dialog types exposed by Chrome DevTools Protocol. */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/** Snapshot of the currently active JavaScript dialog. */
export type DialogStatus = {
	type: DialogType
	message: string
	defaultPrompt: string | null
	url: string | null
	hasBrowserHandler: boolean
	openedAt: number
}

/** Response payload for GET /dialog. */
export type DialogStatusResponse = {
	ok: true
	dialog: DialogStatus | null
}

/** Request payload for POST /dialog. */
export type DialogHandleRequest = {
	action: 'accept' | 'dismiss'
	promptText?: string
}

/** Response payload for POST /dialog. */
export type DialogHandleResponse = {
	ok: true
	action: 'accept' | 'dismiss'
	dialog: DialogStatus
}
