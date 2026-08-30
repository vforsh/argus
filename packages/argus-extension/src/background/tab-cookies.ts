/**
 * Cookie access for an attached tab's cookie store, used by extension-mode auth export to
 * keep sibling subdomain session cookies such as `auth.example.com`.
 */

export type CookieQuery = {
	domain?: string
	url?: string
}

export type NativeCookie = {
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

/** Read cookies from the cookie store that owns `tabId` (incognito tabs use a separate store). */
export const readTabCookies = async (tabId: number, query: CookieQuery = {}): Promise<NativeCookie[]> => {
	const storeId = await findCookieStoreId(tabId)
	const cookies = await chrome.cookies.getAll({
		domain: query.domain,
		storeId: storeId ?? undefined,
		url: query.domain ? undefined : query.url,
	})

	return cookies.map((cookie) => ({
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		secure: cookie.secure,
		httpOnly: cookie.httpOnly,
		session: cookie.session,
		expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : null,
		sameSite: cookie.sameSite ?? null,
	}))
}

const findCookieStoreId = async (tabId: number): Promise<string | null> => {
	const stores = await chrome.cookies.getAllCookieStores()
	const store = stores.find((candidate) => candidate.tabIds.includes(tabId))
	return store?.id ?? null
}
