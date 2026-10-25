/**
 * Init-script protocol (`/page/init-script*` endpoints).
 *
 * Init scripts run before any page script in every new document of the watcher's page
 * (`Page.addScriptToEvaluateOnNewDocument`). They persist in the watcher until removed and are
 * re-registered whenever the watcher reattaches, so they survive reloads and target restarts.
 */
import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalInteger, optionalNonEmptyString, readFields, requireObject, requiredString } from '../schemaFields.js'
import type { ErrorDetail, Ok } from './errors.js'

/** One installed init script. The source itself is not echoed back. */
export type InitScript = {
	/** Watcher-local script id, unique for the watcher lifetime. */
	id: number
	/** Optional human label (the CLI passes the file name). */
	name?: string
	/** Source size in bytes (UTF-8). */
	bytes: number
	/** Whether the script is registered on the currently attached target. */
	registered: boolean
	/** Epoch ms when the script was added. */
	createdAt: number
}

/** POST /page/init-script/add request payload. */
export type InitScriptAddRequest = {
	/** JavaScript source, evaluated as a classic script before page scripts. */
	source: string
	name?: string
	/** Also run the script now in the already loaded document(s). Applies only to this add, not to reattach. */
	runNow?: boolean
}

/** POST /page/init-script/add response. */
export type InitScriptAddResponse = Ok<{
	/** Whether the watcher is currently attached to a CDP target. False means the script is queued. */
	attached: boolean
	script: InitScript
	/** Set when the script could not be registered on the attached target. */
	error?: ErrorDetail | null
}>

/** POST /page/init-script/remove request payload. */
export type InitScriptRemoveRequest = {
	id: number
}

/** POST /page/init-script/remove response. */
export type InitScriptRemoveResponse = Ok<{
	/** True when a script with the given id existed and was removed. */
	removed: boolean
}>

/** POST /page/init-script/clear response. */
export type InitScriptClearResponse = Ok<{
	/** Number of scripts removed. */
	removed: number
}>

/** GET /page/init-script response. */
export type InitScriptStatusResponse = Ok<{
	attached: boolean
	/** Installed scripts in registration (= execution) order. */
	scripts: InitScript[]
	/** Last registration error, if any. */
	lastError?: ErrorDetail | null
}>

/** Schema for POST /page/init-script/add request payloads. */
export const initScriptAddRequestSchema = defineProtocolSchema<InitScriptAddRequest>((value) => {
	const invalid = requireObject<InitScriptAddRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		source: requiredString,
		name: optionalNonEmptyString,
		runNow: optionalBoolean,
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /page/init-script/remove request payloads. */
export const initScriptRemoveRequestSchema = defineProtocolSchema<InitScriptRemoveRequest>((value) => {
	const invalid = requireObject<InitScriptRemoveRequest>(value)
	if (invalid) return invalid

	const id = optionalInteger(value as Record<string, unknown>, 'id', { min: 1 })
	if (typeof id !== 'number') {
		return invalidProtocolPayload('id must be an integer >= 1')
	}

	return validProtocolPayload({ id })
})
