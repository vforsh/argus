import type { DomClickResponse, ReloadResponse, VisibilityResponse } from '@vforsh/argus-core'
import type { DomClickOptions, DomClickResult, ReloadOptions, VisibilityOptions, VisibilityResult } from '../../types.js'
import type { ClientContext } from '../context.js'
import { requestWatcher } from '../watcherRequest.js'

/** Page interaction methods: click, visibility lock, reload. */
export const createPageMethods = (ctx: ClientContext) => ({
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
