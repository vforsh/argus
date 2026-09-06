import type {
	DomClickResponse,
	NavigateHistoryResponse,
	NavigateResponse,
	ReloadResponse,
	StatusResponse,
	VisibilityResponse,
} from '@vforsh/argus-core'
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '@vforsh/argus-core'
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

		const { data } = await requestWatcher<VisibilityResponse>(ctx, watcherId, {
			path: '/visibility',
			timeoutMs: ctx.requestTimeoutMs,
			method: 'POST',
			body: options,
		})

		return { attached: data.attached, state: data.state }
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
