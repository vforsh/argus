/** Serializable page-scoped Google Sheets operation lease. */
export type SheetOperationLease = {
	ok: true
	token: string
	operation: string
	acquiredAt: number
	expiresAt: number
	originalGid: string
	originalUrl: string
}

/** Lease release/restoration metadata. */
export type SheetLeaseRelease = {
	ok: true
	released: boolean
	restored: boolean
	browserCurrentGid: string
	browserCurrentUrl: string
}

/** Build the atomic page-side lease acquisition expression. */
export const buildAcquireLeaseExpression = (input: { token: string; operation: string; ttlMs: number }): string =>
	buildLeaseExpression(acquireLeaseInPage, input)

/** Build a page-side matching-token renewal expression. */
export const buildRenewLeaseExpression = (input: { token: string; ttlMs: number }): string => buildLeaseExpression(renewLeaseInPage, input)

/** Build a page-side matching-token assertion expression. */
export const buildAssertLeaseExpression = (token: string): string => buildLeaseExpression(assertLeaseInPage, { token })

/** Build an owner-checked release expression with optional original-tab restoration. */
export const buildReleaseLeaseExpression = (input: { token: string; restore: boolean }): string => buildLeaseExpression(releaseLeaseInPage, input)

const buildLeaseExpression = <T>(fn: (input: T) => unknown, input: T): string => `(() => {
${[currentGidInPage, activeLeaseTabInPage, pressLeaseTab, waitForLeaseRestoration, assertLeaseInPage].map((helper) => helper.toString()).join('\n')}
return (${fn.toString()})(${JSON.stringify(input)})
})()`

type PageLeaseState = SheetOperationLease & { originalTab: HTMLElement | null }

async function acquireLeaseInPage(input: { token: string; operation: string; ttlMs: number }): Promise<SheetOperationLease> {
	const root = globalThis as typeof globalThis & { __argusGoogleSheetsLeaseV1?: PageLeaseState }
	const now = Date.now()
	const existing = root.__argusGoogleSheetsLeaseV1
	if (existing && existing.expiresAt > now && existing.token !== input.token) {
		const remaining = Math.max(1, existing.expiresAt - now)
		throw new Error(
			`Google Sheets is busy with "${existing.operation}" (${remaining}ms lease remaining). Wait for it to finish or retry after the lease expires.`,
		)
	}
	const staleOriginal = existing?.originalTab ?? null
	const originalTab = activeLeaseTabInPage()
	const lease: PageLeaseState = {
		ok: true,
		token: input.token,
		operation: input.operation,
		acquiredAt: now,
		expiresAt: now + input.ttlMs,
		originalGid: currentGidInPage(),
		originalUrl: location.href,
		originalTab,
	}
	root.__argusGoogleSheetsLeaseV1 = lease
	if (existing && existing.expiresAt <= now && staleOriginal && staleOriginal !== originalTab && staleOriginal.isConnected) {
		pressLeaseTab(staleOriginal)
		await waitForLeaseRestoration(existing.originalGid, 3_000)
		lease.originalGid = currentGidInPage()
		lease.originalUrl = location.href
		lease.originalTab = activeLeaseTabInPage()
	}
	return {
		ok: true,
		token: lease.token,
		operation: lease.operation,
		acquiredAt: lease.acquiredAt,
		expiresAt: lease.expiresAt,
		originalGid: lease.originalGid,
		originalUrl: lease.originalUrl,
	}
}

function assertLeaseInPage(input: { token: string }): SheetOperationLease {
	const root = globalThis as typeof globalThis & { __argusGoogleSheetsLeaseV1?: PageLeaseState }
	const lease = root.__argusGoogleSheetsLeaseV1
	if (!lease || lease.token !== input.token)
		throw new Error('Google Sheets operation lease was lost (page reload or stale takeover); aborting safely.')
	if (lease.expiresAt <= Date.now()) throw new Error('Google Sheets operation lease expired; aborting safely before another UI step.')
	return lease
}

function renewLeaseInPage(input: { token: string; ttlMs: number }): SheetOperationLease {
	const lease = assertLeaseInPage({ token: input.token }) as PageLeaseState
	lease.expiresAt = Date.now() + input.ttlMs
	return lease
}

async function releaseLeaseInPage(input: { token: string; restore: boolean }): Promise<SheetLeaseRelease> {
	const root = globalThis as typeof globalThis & { __argusGoogleSheetsLeaseV1?: PageLeaseState }
	const lease = root.__argusGoogleSheetsLeaseV1
	if (!lease) {
		return { ok: true, released: false, restored: false, browserCurrentGid: currentGidInPage(), browserCurrentUrl: location.href }
	}
	if (lease.token !== input.token) throw new Error('Refusing to release a Google Sheets lease owned by another operation.')
	let restored = currentGidInPage() === lease.originalGid
	try {
		if (input.restore && !restored) {
			if (!lease.originalTab?.isConnected) throw new Error('Original Google Sheets tab is no longer present; active sheet was not restored.')
			pressLeaseTab(lease.originalTab)
			await waitForLeaseRestoration(lease.originalGid, 3_000)
			restored = currentGidInPage() === lease.originalGid
			if (!restored) throw new Error(`Failed to restore original Google Sheets gid ${lease.originalGid}.`)
		}
		return { ok: true, released: true, restored, browserCurrentGid: currentGidInPage(), browserCurrentUrl: location.href }
	} finally {
		if (root.__argusGoogleSheetsLeaseV1?.token === input.token) delete root.__argusGoogleSheetsLeaseV1
	}
}

function currentGidInPage(): string {
	const rendered = Array.from(document.querySelectorAll<HTMLElement>('[id$="-grid-container"]')).find((element) => {
		const rect = element.getBoundingClientRect()
		const style = getComputedStyle(element)
		return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
	})
	return rendered?.id.match(/^(\d+)-grid-container$/)?.[1] ?? location.hash.match(/gid=([^&]+)/)?.[1] ?? '0'
}

function activeLeaseTabInPage(): HTMLElement | null {
	return (
		Array.from(document.querySelectorAll<HTMLElement>('.docs-sheet-tab.docs-sheet-active-tab')).find((element) => {
			const rect = element.getBoundingClientRect()
			const style = getComputedStyle(element)
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
		}) ?? null
	)
}

function pressLeaseTab(element: HTMLElement): void {
	element.scrollIntoView({ block: 'nearest', inline: 'center' })
	const rect = element.getBoundingClientRect()
	for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
		element.dispatchEvent(
			new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				view: window,
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
				button: 0,
			}),
		)
	}
}

async function waitForLeaseRestoration(gid: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (currentGidInPage() === gid) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Timed out restoring Google Sheets gid ${gid}.`)
}
