import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import { compact, optionalInteger, optionalNonEmptyString, readFields, requireObject } from '../schemaFields.js'

import type { ExtensionControlBridgeStatus, ExtensionTabBridgeStatus, ExtensionRecentEvent } from '../native-messaging.js'
import type { Ok } from './errors.js'

export type ExtensionBrowserTab = {
	tabId: number
	url: string
	title: string
	faviconUrl?: string
	attached: boolean
	watcherId?: string
}

export type ExtensionTabsResponse = Ok<{
	tabs: ExtensionBrowserTab[]
}>

/** Result of an extension-control attach/detach request after the extension has applied it. */
export type ExtensionTabActionResponse = Ok<{
	tab: ExtensionBrowserTab
	watcherId?: string
}>

/**
 * One target the extension watcher can attach to: a tab, or an iframe inside one.
 *
 * `attached` and `targetReady` are absent for sources that cannot report them, so treat
 * a missing value as unknown rather than as `false`.
 */
export type ExtensionTargetSummary = {
	/** Target id. Extension tab ids are stringified numbers. */
	id: string
	title: string
	url: string
	/** Target type, such as `page` or `iframe`. */
	type?: string
	/** Parent target id for nested targets. */
	parentId?: string | null
	/** Favicon URL. Extension mode only. */
	faviconUrl?: string
	/** Whether the target currently has a debugger attached. */
	attached?: boolean
	/** False for a selected iframe still waiting for rediscovery or an execution context. */
	targetReady?: boolean
}

/** Response payload for GET /targets. */
export type ExtensionTargetsResponse = Ok<{
	targets: ExtensionTargetSummary[]
}>

/**
 * Request payload for POST /attach.
 *
 * Exactly one of `targetId` or `tabId` identifies the target; `tabId` is the legacy
 * numeric form and is stringified server-side.
 */
export type ExtensionAttachRequest = {
	targetId?: string
	tabId?: number
	/** Watcher id to bind the attached target to. */
	watcherId?: string
}

/** Request payload for POST /detach. Identifies the target like {@link ExtensionAttachRequest}. */
export type ExtensionDetachRequest = {
	targetId?: string
	tabId?: number
}

/** Live diagnostics from the extension-control watcher and connected browser extension. */
export type ExtensionDiagnosticsResponse = Ok<{
	extension: {
		id: string | null
		version: string | null
	}
	control: ExtensionControlBridgeStatus
	tabWatchers: ExtensionTabBridgeStatus[]
	recentEvents: ExtensionRecentEvent[]
}>

/** Read the targetId/tabId pair both extension action routes accept. */
const readExtensionTarget = (value: unknown) =>
	readFields(value as Record<string, unknown>, {
		targetId: optionalNonEmptyString,
		tabId: (source, key) => optionalInteger(source, key),
		watcherId: optionalNonEmptyString,
	})

/** Schema for POST /attach request payloads. */
export const extensionAttachRequestSchema = defineProtocolSchema<ExtensionAttachRequest>((value) => {
	const invalid = requireObject<ExtensionAttachRequest>(value)
	if (invalid) return invalid

	const fields = readExtensionTarget(value)
	if (!fields.ok) return fields
	if (fields.value.targetId == null && fields.value.tabId == null) {
		return invalidProtocolPayload('targetId is required')
	}

	return validProtocolPayload(compact(fields.value))
})

/** Schema for POST /detach request payloads. */
export const extensionDetachRequestSchema = defineProtocolSchema<ExtensionDetachRequest>((value) => {
	const invalid = requireObject<ExtensionDetachRequest>(value)
	if (invalid) return invalid

	const fields = readExtensionTarget(value)
	if (!fields.ok) return fields
	if (fields.value.targetId == null && fields.value.tabId == null) {
		return invalidProtocolPayload('targetId is required')
	}

	return validProtocolPayload(compact({ targetId: fields.value.targetId, tabId: fields.value.tabId }))
})
