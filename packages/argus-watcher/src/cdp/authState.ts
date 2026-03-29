import { buildAuthStateStorageSeedExpression, hydrateAuthState, type AuthStateLoadResponse, type AuthStateSnapshot } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'

/** Apply an auth-state snapshot to the currently attached watcher target. */
export const applyAuthStateToSession = async (input: {
	session: CdpSessionHandle
	snapshot: AuthStateSnapshot
	startupUrl?: string | null
}): Promise<AuthStateLoadResponse> =>
	hydrateAuthState({
		driver: {
			setCookies: async (cookies) => {
				await input.session.sendAndWait(
					'Network.setCookies',
					{
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
					{ timeoutMs: 5_000 },
				)
			},
			navigateAndWait: async (url) => {
				await input.session.sendAndWait('Page.navigate', { url }, { timeoutMs: 5_000 })
				await input.session.sendAndWait(
					'Runtime.evaluate',
					{
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
					{ timeoutMs: 10_000 },
				)
			},
			seedStorage: async (originState) => {
				await input.session.sendAndWait(
					'Runtime.evaluate',
					{
						expression: buildAuthStateStorageSeedExpression(originState),
						awaitPromise: false,
						returnByValue: true,
					},
					{ timeoutMs: 5_000 },
				)
			},
		},
		snapshot: input.snapshot,
		startupUrl: input.startupUrl ?? null,
	})
