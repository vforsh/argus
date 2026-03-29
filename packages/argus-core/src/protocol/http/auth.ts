/** Cookie metadata exposed by the auth cookie endpoints. */
export type AuthCookie = {
	name: string
	domain: string
	path: string
	value?: string | null
	valuePreview: string | null
	secure: boolean
	httpOnly: boolean
	session: boolean
	expires: number | null
	sameSite: string | null
}

/** Response payload for GET /auth/cookies. */
export type AuthCookiesResponse = {
	ok: true
	origin: string
	cookies: AuthCookie[]
}

/** Cookie payload used by auth-state export and import. */
export type AuthStateCookie = {
	name: string
	value: string
	domain: string
	path: string
	secure: boolean
	httpOnly: boolean
	session: boolean
	expires: number | null
	sameSite: string | null
}

/** A single storage entry for localStorage/sessionStorage snapshots. */
export type AuthStateStorageEntry = {
	name: string
	value: string
}

/** Per-origin storage captured alongside cookies in an auth-state snapshot. */
export type AuthStateOrigin = {
	origin: string
	localStorage: AuthStateStorageEntry[]
	sessionStorage: AuthStateStorageEntry[]
}

/** Schema version for the auth-state metadata block. */
export const AUTH_STATE_METADATA_SCHEMA_VERSION = 1

/** Source metadata for auth-state snapshots. */
export type AuthStateSnapshotSourceMetadata = {
	/** Watcher id that produced the snapshot. */
	watcherId: string
	/** Watcher transport used for capture. Null when unavailable. */
	watcherSource: 'cdp' | 'extension' | null
}

/** Page metadata for auth-state snapshots. */
export type AuthStateSnapshotPageMetadata = {
	/** Best-effort page title at export time. */
	title: string | null
	/** Best-effort site domain used for same-site cookie capture. */
	siteDomain: string | null
}

/** Capture summary metadata for auth-state snapshots. */
export type AuthStateSnapshotCaptureMetadata = {
	/** Number of cookies stored in `snapshot.cookies`. */
	cookieCount: number
}

/** Lightweight auth hints that help agents reason about replay usefulness. */
export type AuthStateSnapshotAuthHints = {
	/** Cookie names that look auth-related by conservative name matching. */
	authCookieNames: string[]
}

/** Metadata attached to auth-state snapshots for provenance and triage. */
export type AuthStateSnapshotMetadata = {
	/** Metadata schema version. */
	schemaVersion: number
	/** ISO timestamp when the snapshot was exported. */
	exportedAt: string
	/** Watcher provenance. */
	source: AuthStateSnapshotSourceMetadata
	/** Page context. */
	page: AuthStateSnapshotPageMetadata
	/** Snapshot size summary. */
	capture: AuthStateSnapshotCaptureMetadata
	/** Conservative auth hints for agents. */
	authHints: AuthStateSnapshotAuthHints
	/** Preferred URL to open after hydration. */
	recommendedStartupUrl: string | null
}

/** Portable auth snapshot used to rehydrate a fresh browser session. */
export type AuthStateSnapshot = {
	ok: true
	url: string
	origin: string
	cookies: AuthStateCookie[]
	origins: AuthStateOrigin[]
	metadata: AuthStateSnapshotMetadata
}

/** Request payload for loading an auth-state snapshot into an attached watcher target. */
export type AuthStateLoadRequest = {
	snapshot: AuthStateSnapshot
	url?: string
}

/** Response payload for auth-state hydration requests. */
export type AuthStateLoadResponse = {
	ok: true
	startupUrl: string | null
}
