import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, readFields, requireObject } from '../schemaFields.js'

import type { WatcherRecord } from '../../registry/types.js'
import type { DialogStatus } from './dialog.js'
import type { ArgusProtocolVersion } from '../version.js'
import type { Ok } from './errors.js'

/** Response payload for GET /status. */
export type StatusResponse = Ok<{
	id: string
	pid: number
	attached: boolean
	/** Whether the currently selected target is ready for frame-scoped commands. */
	targetReady?: boolean | null
	target: {
		title: string | null
		url: string | null
		/** Target type, such as `page` or `iframe`, when the source can report it. */
		type?: string | null
		/** Parent target id for nested targets, e.g. `tab:<tabId>` for extension iframes. */
		parentId?: string | null
	} | null
	dialog?: DialogStatus | null
	buffer: {
		size: number
		count: number
		minId: number | null
		maxId: number | null
	}
	watcher: WatcherRecord
	/** Protocol version advertised by the watcher. */
	protocolVersion?: ArgusProtocolVersion
	/** Watcher package version (e.g. "0.1.2"). */
	watcherVersion?: string
	/**
	 * Lifetime counters for side effects that are hard to observe from outside.
	 *
	 * `pageNavigations` counts top-frame navigations the watcher acted on (log rotation,
	 * sourcemap cache reset, indicator repaint). One real navigation must count exactly once;
	 * the extension-mode e2e asserts on it to catch duplicated or lost navigation handling.
	 */
	counters?: {
		pageNavigations: number
	}
}>

/** Response payload for POST /shutdown. */
export type ShutdownResponse = Ok<{}>

/** Request payload for POST /reload. */
export type ReloadRequest = {
	/** If true, bypass browser cache. Default: false. */
	ignoreCache?: boolean
}

/** Response payload for POST /reload. */
export type ReloadResponse = Ok<{}>

/** Schema for POST /reload request payloads. */
export const reloadRequestSchema = defineProtocolSchema<ReloadRequest>((value) => {
	const invalid = requireObject<ReloadRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, { ignoreCache: optionalBoolean })
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})
