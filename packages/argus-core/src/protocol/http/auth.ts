import { normalizeCookieDomainFilter, normalizeCookieSameSite } from '../../auth/cookies.js'
import { defineProtocolSchema, invalidProtocolPayload, validProtocolPayload } from '../schema.js'
import {
	compact,
	fieldError,
	optionalBoolean,
	optionalEnum,
	optionalNumber,
	optionalRecord,
	optionalString,
	readFields,
	requireObject,
	requiredString,
	type FieldError,
} from '../schemaFields.js'
import type { Ok } from './errors.js'

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

/** Exact cookie identity used for lookup/delete responses. */
export type AuthCookieIdentity = {
	name: string
	domain: string
	path: string
}

/** Response payload for GET /auth/cookies. */
export type AuthCookiesResponse = Ok<{
	origin: string
	cookies: AuthCookie[]
}>

/** Request payload for exact cookie lookup. */
export type AuthCookieGetRequest = AuthCookieIdentity & {
	includeValue?: boolean
}

/** Response payload for exact cookie lookup. */
export type AuthCookieGetResponse = Ok<{
	origin: string
	cookie: AuthCookie | null
}>

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

/** Request payload for exact cookie upserts. */
export type AuthCookieSetRequest = {
	cookie: AuthStateCookie
}

/** Response payload for cookie upserts. */
export type AuthCookieSetResponse = Ok<{
	origin: string
	cookie: AuthCookie
}>

/** Request payload for exact cookie deletion. */
export type AuthCookieDeleteRequest = AuthCookieIdentity

/** Response payload for exact cookie deletion. */
export type AuthCookieDeleteResponse = Ok<{
	origin: string
	deleted: boolean
	cookie: AuthCookieIdentity
}>

/** Scope used by bulk cookie clearing. */
export type AuthCookieClearScope = 'origin' | 'site' | 'domain' | 'browserContext'

/** Request payload for scoped cookie clearing. */
export type AuthCookieClearRequest = {
	scope: AuthCookieClearScope
	domain?: string
	sessionOnly?: boolean
	authOnly?: boolean
}

/** Response payload for scoped cookie clearing. */
export type AuthCookieClearResponse = Ok<{
	origin: string
	scope: AuthCookieClearScope
	scopeValue: string | null
	sessionOnly: boolean
	authOnly: boolean
	cleared: number
	cookies: AuthCookieIdentity[]
}>

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
export type AuthStateSnapshot = Ok<{
	url: string
	origin: string
	cookies: AuthStateCookie[]
	origins: AuthStateOrigin[]
	metadata: AuthStateSnapshotMetadata
}>

/** Request payload for loading an auth-state snapshot into an attached watcher target. */
export type AuthStateLoadRequest = {
	snapshot: AuthStateSnapshot
	url?: string
}

/** Response payload for auth-state hydration requests. */
export type AuthStateLoadResponse = Ok<{
	startupUrl: string | null
}>

// ─────────────────────────────────────────────────────────────────────────────
// Request schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Scopes accepted by POST /auth/cookies/clear. */
export const AUTH_COOKIE_CLEAR_SCOPES = ['origin', 'site', 'domain', 'browserContext'] as const

/** Read the name/domain/path triple that identifies one cookie. */
const readCookieIdentity = (source: Record<string, unknown>): AuthCookieIdentity | FieldError => {
	const fields = readFields(source, { name: requiredString, domain: requiredString, path: requiredString })
	if (!fields.ok) {
		// requiredString names the field, which is the message these routes already used.
		return fieldError(fields.issues[0]?.message ?? 'name, domain, and path are required')
	}
	if (!fields.value.path.startsWith('/')) {
		return fieldError('path must start with "/"')
	}
	return fields.value
}

/** Schema for POST /auth/cookies/get request payloads. */
export const authCookieGetRequestSchema = defineProtocolSchema<AuthCookieGetRequest>((value) => {
	const invalid = requireObject<AuthCookieGetRequest>(value)
	if (invalid) return invalid
	const source = value as Record<string, unknown>

	const identity = readCookieIdentity(source)
	if ('__fieldError' in identity) return invalidProtocolPayload(identity.__fieldError)

	const fields = readFields(source, { includeValue: optionalBoolean })
	if (!fields.ok) return fields

	return validProtocolPayload(compact({ ...identity, ...fields.value }))
})

/** Schema for POST /auth/cookies/delete request payloads. */
export const authCookieDeleteRequestSchema = defineProtocolSchema<AuthCookieDeleteRequest>((value) => {
	const invalid = requireObject<AuthCookieDeleteRequest>(value)
	if (invalid) return invalid

	const identity = readCookieIdentity(value as Record<string, unknown>)
	if ('__fieldError' in identity) return invalidProtocolPayload(identity.__fieldError)

	return validProtocolPayload(identity)
})

/** Schema for POST /auth/cookies/set request payloads. */
export const authCookieSetRequestSchema = defineProtocolSchema<AuthCookieSetRequest>((value) => {
	const invalid = requireObject<AuthCookieSetRequest>(value)
	if (invalid) return invalid

	const outer = readFields(value as Record<string, unknown>, { cookie: optionalRecord })
	if (!outer.ok) return outer
	if (outer.value.cookie == null) {
		return invalidProtocolPayload('cookie is required')
	}
	const source = outer.value.cookie

	const identity = readCookieIdentity(source)
	if ('__fieldError' in identity) return invalidProtocolPayload(identity.__fieldError)

	const fields = readFields(source, {
		value: optionalString,
		secure: optionalBoolean,
		httpOnly: optionalBoolean,
		session: optionalBoolean,
		sameSite: optionalString,
		expires: (input, key) => optionalNumber(input, key),
	})
	if (!fields.ok) return fields
	const { value: cookieValue, secure, httpOnly, session, sameSite, expires } = fields.value

	if (typeof cookieValue !== 'string') return invalidProtocolPayload('cookie.value must be a string')
	if (secure == null) return invalidProtocolPayload('cookie.secure must be a boolean')
	if (httpOnly == null) return invalidProtocolPayload('cookie.httpOnly must be a boolean')
	if (session == null) return invalidProtocolPayload('cookie.session must be a boolean')

	const normalizedSameSite = sameSite ? normalizeCookieSameSite(sameSite) : null
	if (sameSite && !normalizedSameSite) {
		return invalidProtocolPayload('cookie.sameSite must be one of: Strict, Lax, None')
	}
	if (session && expires != null) {
		return invalidProtocolPayload('cookie.expires must be null when cookie.session is true')
	}
	if (!session && expires == null) {
		return invalidProtocolPayload('cookie.expires is required when cookie.session is false')
	}
	if (normalizedSameSite === 'None' && !secure) {
		return invalidProtocolPayload('cookie.secure must be true when cookie.sameSite is None')
	}

	return validProtocolPayload({
		cookie: compact({
			...identity,
			value: cookieValue,
			secure,
			httpOnly,
			session,
			sameSite: normalizedSameSite,
			expires: expires ?? null,
		}) as AuthStateCookie,
	})
})

/** Schema for POST /auth/cookies/clear request payloads. */
export const authCookieClearRequestSchema = defineProtocolSchema<AuthCookieClearRequest>((value) => {
	const invalid = requireObject<AuthCookieClearRequest>(value)
	if (invalid) return invalid

	const fields = readFields(value as Record<string, unknown>, {
		scope: (source, key) => optionalEnum(source, key, AUTH_COOKIE_CLEAR_SCOPES),
		domain: optionalString,
		sessionOnly: optionalBoolean,
		authOnly: optionalBoolean,
	})
	if (!fields.ok) return fields
	const { scope, domain } = fields.value

	if (scope == null) {
		return invalidProtocolPayload(`scope must be one of: ${AUTH_COOKIE_CLEAR_SCOPES.join(', ')}`)
	}
	if (scope === 'domain' && !normalizeCookieDomainFilter(domain)) {
		return invalidProtocolPayload('domain is required when scope is "domain"')
	}

	return validProtocolPayload(compact({ ...fields.value, scope }))
})
