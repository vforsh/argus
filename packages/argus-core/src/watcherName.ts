/**
 * Default watcher name for a page, derived from where it lives.
 *
 * Auto-named tab watchers used to be `extension`, `extension-2`, `extension-2-2`: names that say
 * nothing, so agents ran `argus list | grep` before every command and still picked the wrong one.
 * A host-derived name (`elka-game`, `partner-yandex`, `localhost-3333`) is readable, and stays the
 * same across re-attaches of the same site.
 *
 * Returns `undefined` for pages without a meaningful host (`chrome://`, `file:`, `about:blank`);
 * callers keep their previous fallback for those.
 */
export const watcherNameFromUrl = (url: string | undefined): string | undefined => {
	if (!url) return undefined
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return undefined
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined

	const raw = parsed.hostname.toLowerCase().replace(/^www\./, '')
	// IPv6 literals (`[::1]`) have no readable labels; name them by role instead.
	const host = raw.startsWith('[') ? (raw === '[::1]' ? 'localhost' : 'ipv6') : raw
	if (!host) return undefined

	// Local servers are told apart by port, not by name; public hosts by every label but the TLD.
	const local = host === 'localhost' || host === 'ipv6' || /^[0-9.]+$/.test(host)
	const labels = host.split('.')
	if (!local && labels.length > 1) labels.pop()
	const base = labels.join('-') + (local && parsed.port ? `-${parsed.port}` : '')

	const name = base
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '')
	return name ? truncateName(name, MAX_NAME_LENGTH) : undefined
}

const MAX_NAME_LENGTH = 40

/** Cut at a `-` boundary when one is close, so a long host keeps whole words. */
const truncateName = (name: string, max: number): string => {
	if (name.length <= max) return name
	const cut = name.slice(0, max)
	const boundary = cut.lastIndexOf('-')
	return boundary >= max / 2 ? cut.slice(0, boundary) : cut
}
