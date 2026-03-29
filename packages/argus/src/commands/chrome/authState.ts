import {
	buildAuthStateStorageSeedExpression,
	hydrateAuthState,
	type AuthStateCookie,
	type AuthStateOrigin,
	type AuthStateSnapshot,
} from '@vforsh/argus-core'
import type { ChromeTargetResponse } from '../../cdp/types.js'
import { sendCdpCommand, sendCdpRequest } from '../../cdp/sendCdpCommand.js'
import { fetchJson } from '../../httpClient.js'
import { normalizeUrl } from './shared.js'
import { loadAuthStateSnapshot } from '../auth.js'

/**
 * Load an auth-state file into a fresh Chrome instance by seeding cookies first,
 * then restoring storage in the same tab so sessionStorage survives the final navigation.
 */
export const applyAuthStateToChrome = async (input: {
	authStatePath: string
	cdpHost: string
	cdpPort: number
	startupUrl?: string | null
}): Promise<{ startupUrl: string | null }> => {
	const snapshot = await loadAuthStateSnapshot(input.authStatePath)
	return applyAuthStateSnapshotToChrome({
		snapshot,
		cdpHost: input.cdpHost,
		cdpPort: input.cdpPort,
		startupUrl: input.startupUrl,
	})
}

/** Apply an in-memory auth-state snapshot to a fresh Chrome hydration target. */
export const applyAuthStateSnapshotToChrome = async (input: {
	snapshot: AuthStateSnapshot
	cdpHost: string
	cdpPort: number
	startupUrl?: string | null
}): Promise<{ startupUrl: string | null }> => {
	const target = await createHydrationTarget(input.cdpHost, input.cdpPort)

	if (!target.webSocketDebuggerUrl) {
		throw new Error(`Hydration target ${target.id} has no webSocketDebuggerUrl.`)
	}
	const wsUrl = target.webSocketDebuggerUrl

	return hydrateAuthState({
		driver: {
			setCookies: async (cookies) => {
				await setCookies(wsUrl, cookies)
			},
			navigateAndWait: async (url) => {
				await navigateAndWaitForLoad(wsUrl, url)
			},
			seedStorage: async (originState) => {
				await seedStorage(wsUrl, originState)
			},
		},
		snapshot: input.snapshot,
		startupUrl: input.startupUrl ? normalizeUrl(input.startupUrl) : null,
	})
}

const createHydrationTarget = async (cdpHost: string, cdpPort: number): Promise<ChromeTargetResponse> =>
	fetchJson<ChromeTargetResponse>(`http://${cdpHost}:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })

const setCookies = async (wsUrl: string, cookies: AuthStateCookie[]): Promise<void> => {
	if (cookies.length === 0) {
		return
	}

	await sendCdpCommand(wsUrl, {
		id: 1,
		method: 'Network.setCookies',
		params: {
			cookies: cookies.map((cookie) => ({
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
				path: cookie.path,
				secure: cookie.secure,
				httpOnly: cookie.httpOnly,
				sameSite: cookie.sameSite ?? undefined,
				expires: cookie.session ? undefined : (cookie.expires ?? undefined),
			})),
		},
	})
}

const navigateAndWaitForLoad = async (wsUrl: string, url: string): Promise<void> => {
	await sendCdpCommand(wsUrl, {
		id: 1,
		method: 'Page.navigate',
		params: { url },
	})

	await sendCdpRequest(
		wsUrl,
		{
			id: 1,
			method: 'Runtime.evaluate',
			params: {
				expression: `new Promise((resolve) => {
				if (document.readyState === 'complete') {
					resolve(true)
					return
				}
				addEventListener('load', () => resolve(true), { once: true })
			})`,
				awaitPromise: true,
				returnByValue: true,
			},
		},
		10_000,
	)
}

const seedStorage = async (wsUrl: string, originState: AuthStateOrigin): Promise<void> => {
	await sendCdpCommand(wsUrl, {
		id: 1,
		method: 'Runtime.evaluate',
		params: {
			expression: buildAuthStateStorageSeedExpression(originState),
			awaitPromise: false,
			returnByValue: true,
		},
	})
}
