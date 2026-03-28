import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpSessionHandle, CdpTargetContext } from '../cdp/connection.js'

type DelegatingEventSubscription = {
	method: string
	handler: Parameters<CdpSessionHandle['onEvent']>[1]
	off: (() => void) | null
	unbind: () => void
}

export type DelegatingSessionController = {
	rebind: () => void
	dispose: () => void
}

type CreateDelegatingSessionOptions = {
	getCurrentSession: () => ExtensionSession | null
	requireCurrentSession: () => ExtensionSession
	getTargetContext: () => CdpTargetContext
	mapParams?: (method: string, params?: Record<string, unknown>) => Record<string, unknown> | undefined
}

/**
 * Keep a stable session handle while the underlying extension tab attachment changes over time.
 */
export const createDelegatingSession = (
	options: CreateDelegatingSessionOptions,
): { session: CdpSessionHandle; controller: DelegatingSessionController } => {
	const subscriptions = new Set<DelegatingEventSubscription>()
	const rebindSubscriptions = (): void => {
		// Delegating sessions are created before a tab may be attached, so event listeners
		// must follow the active extension session instead of binding once and going stale.
		for (const subscription of subscriptions) {
			subscription.unbind()
			const currentSession = options.getCurrentSession()
			if (!currentSession) {
				continue
			}
			subscription.off = currentSession.handle.onEvent(subscription.method, subscription.handler)
		}
	}

	const disposeSubscriptions = (): void => {
		for (const subscription of subscriptions) {
			subscription.unbind()
		}
		subscriptions.clear()
	}

	const controller: DelegatingSessionController = {
		rebind: rebindSubscriptions,
		dispose: disposeSubscriptions,
	}

	const session: CdpSessionHandle = {
		isAttached: () => options.getCurrentSession()?.handle.isAttached() ?? false,
		sendAndWait: async (method, params, commandOptions) => {
			const currentSession = options.requireCurrentSession()
			const targetContext = options.getTargetContext()
			const nextParams = options.mapParams ? options.mapParams(method, params) : params
			const nextOptions =
				targetContext.kind === 'frame' && targetContext.sessionId
					? { ...(commandOptions ?? {}), sessionId: targetContext.sessionId }
					: commandOptions
			return currentSession.handle.sendAndWait(method, nextParams, nextOptions)
		},
		onEvent: (method, handler) => {
			const subscription = createDelegatingEventSubscription(method, handler)
			subscriptions.add(subscription)
			controller.rebind()

			return () => {
				subscription.unbind()
				subscriptions.delete(subscription)
			}
		},
		getTargetContext: options.getTargetContext,
	}

	controller.rebind()
	return { session, controller }
}

const createDelegatingEventSubscription = (method: string, handler: Parameters<CdpSessionHandle['onEvent']>[1]): DelegatingEventSubscription => ({
	method,
	handler,
	off: null,
	unbind() {
		this.off?.()
		this.off = null
	},
})
