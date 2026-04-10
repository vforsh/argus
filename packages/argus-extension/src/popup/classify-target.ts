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

/** URL substrings that indicate tracking, ads, or consent infrastructure. */
const LOW_INTEREST_URL_SUBSTRINGS: string[] = [
	'doubleclick.net',
	'googlesyndication.com',
	'google.com/recaptcha',
	'googletagmanager.com',
	'google-analytics.com',
	'googleadservices.com',
	'connect.facebook.net',
	'facebook.com/tr',
	'ozone-project.com',
	'amazon-adsystem.com',
	'adnxs.com',
	'adsrvr.org',
	'criteo.com',
	'rubiconproject.com',
	'pubmatic.com',
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

	const urlLower = url.toLowerCase()
	if (LOW_INTEREST_URL_SUBSTRINGS.some((pattern) => urlLower.includes(pattern))) return true

	const title = target.title
	if (title && LOW_INTEREST_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true

	return false
}
