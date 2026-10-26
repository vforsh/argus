import { defineProtocolSchema, validProtocolPayload } from '../schema.js'
import { compact, optionalBoolean, optionalNumber, readFields, requireObject } from '../schemaFields.js'

import type { WatcherRecord } from '../../registry/types.js'
import type { DialogStatus } from './dialog.js'
import type { RecordStatusSummary } from './record.js'
import type { TraceStatusSummary } from './trace.js'
import type { ArgusProtocolVersion } from '../version.js'
import type { Ok } from './errors.js'

/** Response payload for GET /status. */
export type StatusResponse = Ok<{
	id: string
	pid: number
	/**
	 * Per-run owner token of the responding process (see `WatcherRecord.ownerId`).
	 * Compare it with the registry record to prove the answering process is the record's owner;
	 * `id` and `pid` alone can't tell two processes sharing one id apart. Absent on older watchers.
	 */
	ownerId?: string
	attached: boolean
	/** Whether the currently selected target is ready for frame-scoped commands. */
	targetReady?: boolean | null
	target: {
		/** Selected target id: Chrome target id (CDP) or the extension's tab/frame target id. Absent on older watchers. */
		id?: string | null
		title: string | null
		url: string | null
		/** Target type, such as `page` or `iframe`, when the source can report it. */
		type?: string | null
		/** Parent target id for nested targets, e.g. `tab:<tabId>` for extension iframes. */
		parentId?: string | null
	} | null
	dialog?: DialogStatus | null
	/**
	 * The active video recording, or `null` when nothing is recording.
	 *
	 * An open-ended `record start` is otherwise invisible from outside the watcher: it holds an
	 * ffmpeg child and a screencast subscription with nothing in `argus list` or `argus status` to
	 * show for it, so a forgotten one was only discoverable by killing the watcher.
	 */
	recording?: RecordStatusSummary | null
	/**
	 * The active Chrome trace, or `null`. Chrome allows one tracing session per browser, so a
	 * rejected `trace start` reads this from every watcher to name who holds it. Absent on older watchers.
	 */
	trace?: TraceStatusSummary | null
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
	/**
	 * How long the watcher waits for Chrome to answer `Page.reload`, in milliseconds. Default:
	 * {@link DEFAULT_RELOAD_TIMEOUT_MS}. The load itself is never awaited (use `--until`).
	 */
	timeoutMs?: number
}

/**
 * Default `/reload` budget.
 *
 * Chrome answers `Page.reload` as soon as the reload starts: ~150ms on both transports even with
 * the renderer blocked or a 12s busy `beforeunload` (measured 2026-10). Yet observed agent reloads
 * took ~9s typical and ~48s p90, and the old 10s client timeout produced bare transport timeouts,
 * so the slow cases are stalls before Chrome (extension worker/bridge, busy watcher). The budget
 * lets those finish, and a real stall gets the watcher's layered diagnosis instead.
 */
export const DEFAULT_RELOAD_TIMEOUT_MS = 60_000

/** Response payload for POST /reload. */
export type ReloadResponse = Ok<{}>

/** Schema for POST /reload request payloads. */
export const reloadRequestSchema = defineProtocolSchema<ReloadRequest>((value) => {
	const invalid = requireObject<ReloadRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		ignoreCache: optionalBoolean,
		timeoutMs: (source, key) => optionalNumber(source, key, { min: 1 }),
	})
	if (!fields.ok) return fields

	return validProtocolPayload(compact(fields.value))
})
