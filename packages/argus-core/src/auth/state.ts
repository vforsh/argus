import {
	AUTH_STATE_METADATA_SCHEMA_VERSION,
	type AuthStateCookie,
	type AuthStateLoadResponse,
	type AuthStateOrigin,
	type AuthStateSnapshot,
	type AuthStateSnapshotMetadata,
} from '../protocol/http/auth.js'

/**
 * Transport-agnostic driver for replaying an auth snapshot into a browser tab.
 * Implementations decide how CDP commands are sent.
 */
export type AuthStateHydrationDriver = {
	setCookies: (cookies: AuthStateCookie[]) => Promise<void>
	navigateAndWait: (url: string) => Promise<void>
	seedStorage: (originState: AuthStateOrigin) => Promise<void>
}

/**
 * Parse an unknown JSON payload into a validated auth-state snapshot.
 * Throws with a descriptive error when the payload shape is not usable.
 */
export const parseAuthStateSnapshot = (value: unknown, source = 'auth state snapshot'): AuthStateSnapshot => {
	const snapshot = expectRecord(value, source)

	if (snapshot.ok !== true) {
		throw new Error(`Invalid ${source}: "ok" must be true`)
	}

	return {
		ok: true,
		url: expectString(snapshot.url, `${source}.url`),
		origin: expectString(snapshot.origin, `${source}.origin`),
		cookies: expectArray(snapshot.cookies, `${source}.cookies`).map((cookie, index) =>
			parseAuthStateCookie(cookie, `${source}.cookies[${index}]`),
		),
		origins: expectArray(snapshot.origins, `${source}.origins`).map((originState, index) =>
			parseAuthStateOrigin(originState, `${source}.origins[${index}]`),
		),
		metadata: parseAuthStateMetadata(snapshot.metadata, `${source}.metadata`),
	}
}

/**
 * Replay an auth-state snapshot into a single browser tab.
 * Storage is restored after navigating to each origin so sessionStorage stays bound to that tab.
 */
export const hydrateAuthState = async (input: {
	driver: AuthStateHydrationDriver
	snapshot: AuthStateSnapshot
	startupUrl?: string | null
}): Promise<AuthStateLoadResponse> => {
	const startupUrl = resolveAuthStateStartupUrl(input.startupUrl ?? null, input.snapshot)

	if (input.snapshot.cookies.length > 0) {
		await input.driver.setCookies(input.snapshot.cookies)
	}

	for (const originState of input.snapshot.origins) {
		if (!hasAuthStateStorage(originState)) {
			continue
		}

		await input.driver.navigateAndWait(createAuthStateOriginUrl(originState.origin))
		await input.driver.seedStorage(originState)
	}

	if (startupUrl) {
		await input.driver.navigateAndWait(startupUrl)
	}

	return { ok: true, startupUrl }
}

/** Resolve the final URL opened after auth-state hydration. */
export const resolveAuthStateStartupUrl = (startupUrl: string | null, snapshot: Pick<AuthStateSnapshot, 'url' | 'origin'>): string | null => {
	if (startupUrl?.trim()) {
		return startupUrl.trim()
	}
	if (snapshot.url.trim()) {
		return snapshot.url.trim()
	}
	if (snapshot.origin.trim()) {
		return createAuthStateOriginUrl(snapshot.origin)
	}
	return null
}

/** Convert an origin string into a navigable URL with a trailing slash. */
export const createAuthStateOriginUrl = (origin: string): string => `${origin.replace(/\/$/, '')}/`

/** Build the storage-restore script shared by watcher and Chrome-start hydration paths. */
export const buildAuthStateStorageSeedExpression = (originState: AuthStateOrigin): string => `(() => {
	const payload = ${JSON.stringify(originState)}
	const applyEntries = (storage, entries) => {
		for (const entry of entries) {
			storage.setItem(entry.name, entry.value)
		}
	}

	applyEntries(localStorage, payload.localStorage)
	applyEntries(sessionStorage, payload.sessionStorage)
	return true
})()`

const hasAuthStateStorage = (originState: Pick<AuthStateOrigin, 'localStorage' | 'sessionStorage'>): boolean =>
	originState.localStorage.length > 0 || originState.sessionStorage.length > 0

const parseAuthStateCookie = (value: unknown, source: string): AuthStateCookie => {
	const cookie = expectRecord(value, source)

	return {
		name: expectString(cookie.name, `${source}.name`),
		value: expectString(cookie.value, `${source}.value`),
		domain: expectString(cookie.domain, `${source}.domain`),
		path: expectString(cookie.path, `${source}.path`),
		secure: expectBoolean(cookie.secure, `${source}.secure`),
		httpOnly: expectBoolean(cookie.httpOnly, `${source}.httpOnly`),
		session: expectBoolean(cookie.session, `${source}.session`),
		expires: expectNullableNumber(cookie.expires, `${source}.expires`),
		sameSite: expectNullableString(cookie.sameSite, `${source}.sameSite`),
	}
}

const parseAuthStateOrigin = (value: unknown, source: string): AuthStateOrigin => {
	const originState = expectRecord(value, source)

	return {
		origin: expectString(originState.origin, `${source}.origin`),
		localStorage: expectArray(originState.localStorage, `${source}.localStorage`).map((entry, index) =>
			parseStorageEntry(entry, `${source}.localStorage[${index}]`),
		),
		sessionStorage: expectArray(originState.sessionStorage, `${source}.sessionStorage`).map((entry, index) =>
			parseStorageEntry(entry, `${source}.sessionStorage[${index}]`),
		),
	}
}

const parseAuthStateMetadata = (value: unknown, source: string): AuthStateSnapshotMetadata => {
	const metadata = expectRecord(value, source)
	const schemaVersionSource = `${source}.schemaVersion`
	const schemaVersion = expectNumber(metadata.schemaVersion, schemaVersionSource)
	if (schemaVersion !== AUTH_STATE_METADATA_SCHEMA_VERSION) {
		throw new Error(`Invalid ${schemaVersionSource}: expected ${AUTH_STATE_METADATA_SCHEMA_VERSION}, got ${schemaVersion}`)
	}

	const sourcePath = `${source}.source`
	const pagePath = `${source}.page`
	const capturePath = `${source}.capture`
	const authHintsPath = `${source}.authHints`
	const sourceMetadata = expectRecord(metadata.source, sourcePath)
	const pageMetadata = expectRecord(metadata.page, pagePath)
	const captureMetadata = expectRecord(metadata.capture, capturePath)
	const authHints = expectRecord(metadata.authHints, authHintsPath)

	return {
		schemaVersion,
		exportedAt: expectString(metadata.exportedAt, `${source}.exportedAt`),
		source: {
			watcherId: expectString(sourceMetadata.watcherId, `${sourcePath}.watcherId`),
			watcherSource: expectNullableWatcherSource(sourceMetadata.watcherSource, `${sourcePath}.watcherSource`),
		},
		page: {
			title: expectNullableString(pageMetadata.title, `${pagePath}.title`),
			siteDomain: expectNullableString(pageMetadata.siteDomain, `${pagePath}.siteDomain`),
		},
		capture: {
			cookieCount: expectNumber(captureMetadata.cookieCount, `${capturePath}.cookieCount`),
		},
		authHints: {
			authCookieNames: parseStringArray(authHints.authCookieNames, `${authHintsPath}.authCookieNames`),
		},
		recommendedStartupUrl: expectNullableString(metadata.recommendedStartupUrl, `${source}.recommendedStartupUrl`),
	}
}

const parseStorageEntry = (value: unknown, source: string): { name: string; value: string } => {
	const entry = expectRecord(value, source)
	return {
		name: expectString(entry.name, `${source}.name`),
		value: expectString(entry.value, `${source}.value`),
	}
}

const parseStringArray = (value: unknown, source: string): string[] =>
	expectArray(value, source).map((entry, index) => expectString(entry, `${source}[${index}]`))

const expectRecord = (value: unknown, source: string): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Invalid ${source}: expected an object`)
	}
	return value as Record<string, unknown>
}

const expectArray = (value: unknown, source: string): unknown[] => {
	if (!Array.isArray(value)) {
		throw new Error(`Invalid ${source}: expected an array`)
	}
	return value
}

const expectString = (value: unknown, source: string): string => {
	if (typeof value !== 'string') {
		throw new Error(`Invalid ${source}: expected a string`)
	}
	return value
}

const expectBoolean = (value: unknown, source: string): boolean => {
	if (typeof value !== 'boolean') {
		throw new Error(`Invalid ${source}: expected a boolean`)
	}
	return value
}

const expectNumber = (value: unknown, source: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`Invalid ${source}: expected a finite number`)
	}
	return value
}

const expectNullableString = (value: unknown, source: string): string | null => {
	if (value === null) {
		return null
	}
	return expectString(value, source)
}

const expectNullableNumber = (value: unknown, source: string): number | null => {
	if (value === null) {
		return null
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`Invalid ${source}: expected a finite number or null`)
	}
	return value
}

const expectNullableWatcherSource = (value: unknown, source: string): 'cdp' | 'extension' | null => {
	if (value === null) {
		return null
	}
	if (value === 'cdp' || value === 'extension') {
		return value
	}
	throw new Error(`Invalid ${source}: expected "cdp", "extension", or null`)
}
