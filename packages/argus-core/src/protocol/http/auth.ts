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
