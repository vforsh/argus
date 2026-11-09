import type { NetworkThrottleClearResponse, NetworkThrottleSetResponse, NetworkThrottleState, ThrottleStatusResponse } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { applyNetworkThrottle, clearNetworkThrottle } from '../cdp/throttle.js'
import { createStickyController } from '../stickyController.js'

export type NetworkThrottleController = {
	getStatus: (ctx: { attached: boolean }) => NonNullable<ThrottleStatusResponse['network']>
	setDesired: (state: NetworkThrottleState, session: CdpSessionHandle | null) => Promise<NetworkThrottleSetResponse>
	clearDesired: (session: CdpSessionHandle | null) => Promise<NetworkThrottleClearResponse>
	onAttach: (session: CdpSessionHandle) => Promise<void>
}

/**
 * Desired network conditions, re-applied on every attach until cleared.
 *
 * Chrome drops the conditions with the CDP session that set them, which is why the watcher has
 * to own them: a one-shot script loses the throttle as soon as it disconnects. Within a session
 * they survive reloads and cross-site navigations on their own.
 *
 * Always driven with the page session. Conditions cover the requests of that one target, so
 * out-of-process iframes and workers of the page keep their normal network.
 */
export const createNetworkThrottleController = (): NetworkThrottleController => {
	const sticky = createStickyController<NetworkThrottleState>({
		label: 'Network throttle',
		apply: applyNetworkThrottle,
		clear: clearNetworkThrottle,
	})

	/**
	 * Applying takes two CDP round trips, so an overlapping clear could land between them and be
	 * undone by the second: Chrome throttled, status reporting `none`. Mutations run one at a time.
	 */
	let tail: Promise<unknown> = Promise.resolve()
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation)
		tail = result.catch(() => undefined)
		return result
	}

	return {
		getStatus: (ctx) => {
			const { applied, state, lastError } = sticky.getState()
			// The sticky flag is only refreshed by the next set or attach, so it outlives the session it describes.
			return { applied: applied && ctx.attached, state, lastError }
		},
		setDesired: (desired, session) =>
			serialize(async () => {
				const { attached, applied, state, lastError } = await sticky.setDesired(desired, session)
				return { ok: true, attached, applied, state, ...(lastError ? { error: lastError } : {}) }
			}),
		clearDesired: (session) =>
			serialize(async () => {
				const { attached, applied, lastError } = await sticky.clearDesired(session)
				return { ok: true, attached, applied, state: null, ...(lastError ? { error: lastError } : {}) }
			}),
		onAttach: (session) => serialize(() => sticky.onAttach(session)),
	}
}
