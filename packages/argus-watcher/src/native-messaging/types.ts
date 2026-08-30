/**
 * Native Messaging types used by the watcher in extension mode.
 *
 * The wire contract is defined once in `@vforsh/argus-core` and re-exported here; only
 * the watcher-local CDP session plumbing below is specific to this side.
 */
export * from '@vforsh/argus-core/native-messaging'

// ============================================================
// CDP Session types
// ============================================================

export type PendingRequest = {
	requestId: number
	resolve: (result: unknown) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

// Event dispatch is the same contract on both transports; re-exported rather than
// re-declared so the extension session cannot drift from the direct CDP one.
export type { CdpEventHandler, CdpEventMeta } from '../cdp/connection.js'
