export type OAuthTokenRequest = {
	scopes: string[]
	interactive?: boolean
}

export type OAuthTokenResponse = {
	ok: true
	token: string
	grantedScopes?: string[]
}
