/**
 * Heuristic classification of iframe targets as "low-interest" (ad trackers,
 * consent managers, analytics pixels, etc.) so the popup can collapse them
 * behind a toggle instead of cluttering the target list.
 *
 * Runs purely on the URL and title strings already available in PopupTarget —
 * no DOM access or background queries needed.
 */

type ClassifiableTarget = {
	type: 'page' | 'iframe'
	url: string
	title: string
}

type LowInterestUrlRule = {
	host: string
	pathPrefix?: string
}

/**
 * URL rules for iframes that are usually browser/app infrastructure, not the
 * user's debuggable surface. Host suffix matching covers subdomains.
 */
const LOW_INTEREST_URL_RULES: LowInterestUrlRule[] = [
	{ host: 'accounts.google.com', pathPrefix: '/RotateCookiesPage' },
	{ host: 'clients6.google.com', pathPrefix: '/static/proxy.html' },
	{ host: 'contacts.google.com', pathPrefix: '/u/2/widget/hovercard/' },
	{ host: 'docs.google.com', pathPrefix: '/_/og/bscframe' },
	{ host: 'docs.google.com', pathPrefix: '/offline/iframeapi' },
	{ host: 'doubleclick.net' },
	{ host: 'googlesyndication.com' },
	{ host: 'google.com', pathPrefix: '/recaptcha' },
	{ host: 'googletagmanager.com' },
	{ host: 'google-analytics.com' },
	{ host: 'googleadservices.com' },
	{ host: 'connect.facebook.net' },
	{ host: 'facebook.com', pathPrefix: '/tr' },
	{ host: 'ozone-project.com' },
	{ host: 'amazon-adsystem.com' },
	{ host: 'adnxs.com' },
	{ host: 'adsrvr.org' },
	{ host: 'criteo.com' },
	{ host: 'inmobi.com' },
	{ host: 'rubiconproject.com' },
	{ host: 'pubmatic.com' },
]

/**
 * Title patterns that indicate framework-internal / utility iframes.
 * Matched against the full title string.
 */
const LOW_INTEREST_TITLE_PATTERNS: RegExp[] = [
	/^__\w+__$/, // __pb_locator__, __tcfapiLocator
	/^googlefc/i, // googlefcPresent, googlefcInactive, googlefcLoaded
]

export function isLowInterestTarget(target: ClassifiableTarget): boolean {
	if (target.type === 'page') return false

	const url = target.url
	if (!url || url === 'about:blank' || url === 'about:srcdoc') return true

	if (matchesLowInterestUrl(url)) return true

	const title = target.title
	if (title && LOW_INTEREST_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true

	return false
}

function matchesLowInterestUrl(url: string): boolean {
	try {
		const parsed = new URL(url)
		return LOW_INTEREST_URL_RULES.some((rule) => matchesUrlRule(parsed, rule))
	} catch {
		return false
	}
}

function matchesUrlRule(url: URL, rule: LowInterestUrlRule): boolean {
	if (!matchesHost(url.hostname, rule.host)) return false
	if (!rule.pathPrefix) return true

	return url.pathname.startsWith(rule.pathPrefix)
}

function matchesHost(hostname: string, host: string): boolean {
	return hostname === host || hostname.endsWith(`.${host}`)
}
