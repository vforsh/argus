import {
	AUTH_STATE_METADATA_SCHEMA_VERSION,
	getLikelySiteDomain,
	isLikelyAuthCookieName,
	normalizeCookieDomainFilter,
	type AuthStateCookie,
	type AuthStateSnapshot,
	type AuthStateSnapshotMetadata,
} from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { inspectPageState, normalizeStorageEntries, type PageState } from './authPageState.js'
import { readStateCookies, type BrowserCookieReader } from './authCookies.js'

/** Provenance recorded on an exported snapshot. */
export type SnapshotMetadataInput = {
	exportedAt: string
	watcherId: string
	watcherSource: 'cdp' | 'extension' | null
}

/** Read a portable auth-state snapshot for the attached page. */
export const inspectAuthState = async (
	session: CdpSessionHandle,
	options: { domain?: string; readBrowserCookies?: BrowserCookieReader; metadata: SnapshotMetadataInput },
): Promise<AuthStateSnapshot> => {
	const pageState = await inspectPageState(session)
	const siteDomain = getLikelySiteDomain(pageState.origin)
	const normalizedDomain = normalizeCookieDomainFilter(options.domain) ?? siteDomain
	const cookies = await readStateCookies(session, options.readBrowserCookies, {
		domain: normalizedDomain,
		url: pageState.url,
	})

	return {
		ok: true,
		url: pageState.url,
		origin: pageState.origin,
		cookies,
		origins: [
			{
				origin: pageState.origin,
				localStorage: normalizeStorageEntries(pageState.localStorage),
				sessionStorage: normalizeStorageEntries(pageState.sessionStorage),
			},
		],
		metadata: buildSnapshotMetadata(pageState, cookies, siteDomain, options.metadata),
	}
}

const buildSnapshotMetadata = (
	pageState: Pick<PageState, 'title' | 'url' | 'origin'>,
	cookies: AuthStateCookie[],
	siteDomain: string | null,
	input: SnapshotMetadataInput,
): AuthStateSnapshotMetadata => ({
	schemaVersion: AUTH_STATE_METADATA_SCHEMA_VERSION,
	exportedAt: input.exportedAt,
	source: {
		watcherId: input.watcherId,
		watcherSource: input.watcherSource,
	},
	page: {
		title: pageState.title,
		siteDomain,
	},
	capture: {
		cookieCount: cookies.length,
	},
	authHints: {
		authCookieNames: Array.from(new Set(cookies.map((cookie) => cookie.name).filter(isLikelyAuthCookieName))).sort((a, b) => a.localeCompare(b)),
	},
	recommendedStartupUrl: pageState.url,
})
