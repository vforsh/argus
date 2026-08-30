import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalEnum, optionalString, readFields, requireObject } from '../schemaFields.js'

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

/** Actions accepted by POST /dialog. */
export const DIALOG_ACTIONS = ['accept', 'dismiss'] as const

/** Schema for POST /dialog request payloads. */
export const dialogHandleRequestSchema = defineProtocolSchema<DialogHandleRequest>((value) => {
	const invalid = requireObject<DialogHandleRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		action: (source, key) => optionalEnum(source, key, DIALOG_ACTIONS),
		promptText: optionalString,
	})
	if (!fields.ok) return fields
	const { action, promptText } = fields.value

	if (action == null) {
		return invalidProtocolPayload('Dialog action must be "accept" or "dismiss"')
	}

	return validProtocolPayload(compact({ action, promptText }))
})
