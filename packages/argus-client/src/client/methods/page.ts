import type {
	DomClickResponse,
	NavigateHistoryResponse,
	NavigateResponse,
	ReloadResponse,
	StatusResponse,
	VisibilityPolicy,
	VisibilityResponse,
} from '@vforsh/argus-core'
import { DEFAULT_NAVIGATION_TIMEOUT_MS, VISIBILITY_POLICIES, formatError } from '@vforsh/argus-core'
import type {
	DomClickOptions,
	DomClickResult,
	NavigateOptions,
	NavigateResult,
	NavigateHistoryOptions,
	NavigateHistoryResult,
	PageUrlResult,
	ReloadOptions,
	VisibilityOptions,
	VisibilityResult,
	VisibilityStatusResult,
} from '../../types.js'
import type { ClientContext } from '../context.js'
import { requestWatcher } from '../watcherRequest.js'

/**
 * How long to give the transport beyond the navigation's own wait budget.
 *
 * The watcher holds the request for the whole wait, so a transport timeout equal to it would
 * race the answer and report a client-side timeout instead of the watcher's `navigation_timeout`,
 * which is the one that says something about the page.
 */
const NAVIGATION_TRANSPORT_SLACK_MS = 5_000

const navigationTimeoutMs = (timeoutMs?: number): number => (timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS) + NAVIGATION_TRANSPORT_SLACK_MS

/** Page interaction methods: navigation, click, visibility lock, reload. */
export const createPageMethods = (ctx: ClientContext) => ({
	navigate: async (watcherId: string, options: NavigateOptions): Promise<NavigateResult> => {
		const hasParams = (options?.param?.length ?? 0) > 0 || options?.params != null
		if (!options?.url && !hasParams) {
			throw new Error('url, param, or params is required')
		}

		const { data } = await requestWatcher<NavigateResponse>(ctx, watcherId, {
			path: '/navigate',
			timeoutMs: navigationTimeoutMs(options.timeoutMs),
			method: 'POST',
			body: options,
		})

		return { requestedUrl: data.requestedUrl, url: data.url, loaderId: data.loaderId, epoch: data.epoch, waited: data.waited }
	},

	back: async (watcherId: string, options: NavigateHistoryOptions = {}): Promise<NavigateHistoryResult> =>
		navigateHistory(ctx, watcherId, 'back', options),

	forward: async (watcherId: string, options: NavigateHistoryOptions = {}): Promise<NavigateHistoryResult> =>
		navigateHistory(ctx, watcherId, 'forward', options),

	url: async (watcherId: string): Promise<PageUrlResult> => {
		const { data } = await requestWatcher<StatusResponse>(ctx, watcherId, { path: '/status', timeoutMs: ctx.requestTimeoutMs })
		return { url: data.target?.url ?? null, title: data.target?.title ?? null, attached: data.attached }
	},

	domClick: async (watcherId: string, options: DomClickOptions): Promise<DomClickResult> => {
		const hasTarget = Boolean(options?.selector || options?.ref) || options?.x != null || options?.y != null
		if (!hasTarget) {
			throw new Error('selector, ref, or x,y coordinates are required')
		}

		const { data } = await requestWatcher<DomClickResponse>(ctx, watcherId, {
			path: '/dom/click',
			timeoutMs: ctx.requestTimeoutMs,
			method: 'POST',
			body: options,
		})

		return { matches: data.matches, clicked: data.clicked }
	},

	visibility: async (watcherId: string, options: VisibilityOptions): Promise<VisibilityResult> => {
		if (options?.action !== 'show' && options?.action !== 'hide') {
			throw new Error("action must be 'show' or 'hide'")
		}
		if (options.policy != null || options.activate === false) {
			await verifyVisibilityPolicy(ctx, watcherId)
		}

		const { data } = await requestWatcher<VisibilityResponse>(ctx, watcherId, {
			path: '/visibility',
			timeoutMs: ctx.requestTimeoutMs,
			method: 'POST',
			body: options,
		})

		const policy = readVisibilityPolicy(data)
		if (policy == null) {
			// Older watchers predate the policy field; their action-only behavior was always foreground.
			if (options.policy == null && options.activate == null) return { attached: data.attached, state: data.state, policy: 'foreground' }
			throw unsupportedVisibilityError(watcherId)
		}

		return { attached: data.attached, state: data.state, policy }
	},

	visibilityStatus: async (watcherId: string): Promise<VisibilityStatusResult> => {
		const { data } = await requestVisibilityStatus(ctx, watcherId)

		const policy = readVisibilityPolicy(data)
		if (policy == null) throw unsupportedVisibilityError(watcherId)
		return { attached: data.attached, state: data.state, policy }
	},

	reload: async (watcherId: string, options: ReloadOptions = {}): Promise<void> => {
		await requestWatcher<ReloadResponse>(ctx, watcherId, {
			path: '/reload',
			timeoutMs: ctx.requestTimeoutMs,
			method: 'POST',
			body: { ignoreCache: options.ignoreCache ?? false },
		})
	},
})

const requestVisibilityStatus = (ctx: ClientContext, watcherId: string) =>
	requestWatcher<VisibilityResponse>(ctx, watcherId, {
		path: '/visibility',
		timeoutMs: ctx.requestTimeoutMs,
		method: 'GET',
	})

const verifyVisibilityPolicy = async (ctx: ClientContext, watcherId: string): Promise<void> => {
	let data: VisibilityResponse
	try {
		;({ data } = await requestVisibilityStatus(ctx, watcherId))
	} catch (error) {
		throw new Error(`Cannot verify visibility policy for watcher ${watcherId}: ${formatError(error)} Restart or update the watcher, then retry.`)
	}

	if (readVisibilityPolicy(data) == null) throw unsupportedVisibilityError(watcherId)
}

const readVisibilityPolicy = (data: unknown): VisibilityPolicy | undefined => {
	if (data == null || typeof data !== 'object') return undefined
	const { ok, attached, state, policy } = data as Partial<VisibilityResponse>
	if (ok !== true || typeof attached !== 'boolean' || (state !== 'shown' && state !== 'default')) return undefined
	return VISIBILITY_POLICIES.includes(policy as VisibilityPolicy) ? (policy as VisibilityPolicy) : undefined
}

const unsupportedVisibilityError = (watcherId: string): Error =>
	new Error(
		`Cannot verify visibility policy for watcher ${watcherId}: the watcher did not return a supported policy. Restart or update the watcher, then retry.`,
	)

/** Shared body for `back`/`forward`; the two differ only by direction. */
const navigateHistory = async (
	ctx: ClientContext,
	watcherId: string,
	direction: 'back' | 'forward',
	options: NavigateHistoryOptions,
): Promise<NavigateHistoryResult> => {
	const { data } = await requestWatcher<NavigateHistoryResponse>(ctx, watcherId, {
		path: '/navigate/history',
		timeoutMs: navigationTimeoutMs(options.timeoutMs),
		method: 'POST',
		body: { ...options, direction },
	})

	return { url: data.url, index: data.index, length: data.length, epoch: data.epoch, waited: data.waited }
}
