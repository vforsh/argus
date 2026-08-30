import type { ExtensionSession } from '../native-messaging/session-manager.js'
import type { CdpEventHandler, CdpSendOptions, CdpSessionHandle, CdpTargetContext } from '../cdp/connection.js'
import type { CdpEvent, CdpMethod, CdpParams } from '../cdp/protocol.js'

/**
 * One re-bindable event subscription.
 *
 * The registry holds subscriptions for many different events at once, so the payload type
 * is erased here and restored when re-subscribing — the pairing of `method` and `handler`
 * was checked at the `onEvent` call that created the record.
 */
type DelegatingEventSubscription = {
	method: CdpEvent
	handler: CdpEventHandler<never>
	off: (() => void) | null
	unbind: () => void
}

/**
 * A command about to be forwarded, discriminated by method.
 *
 * Written as a mapped union rather than `{ method: CdpMethod; params?: ... }` so that
 * narrowing on `command.method` also narrows `command.params` to that method's shape.
 */
type PreparedCdpCommand = {
	[M in CdpMethod]: {
		method: M
		params?: CdpParams<M>
		commandOptions?: CdpSendOptions
		targetContext: CdpTargetContext
	}
}[CdpMethod]

export type DelegatingSessionController = {
	rebind: () => void
	dispose: () => void
}

type CreateDelegatingSessionOptions = {
	getCurrentSession: () => ExtensionSession | null
	requireCurrentSession: () => ExtensionSession
	getTargetContext: () => CdpTargetContext
	getReadyTargetContext?: () => Promise<CdpTargetContext>
	prepareCommand?: (command: PreparedCdpCommand) =>
		| {
				params?: CdpParams<CdpMethod>
				commandOptions?: CdpSendOptions
				targetContext?: CdpTargetContext
		  }
		| Promise<{
				params?: CdpParams<CdpMethod>
				commandOptions?: CdpSendOptions
				targetContext?: CdpTargetContext
		  } | void>
		| void
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
			subscription.off = currentSession.handle.onEvent(subscription.method, subscription.handler as CdpEventHandler<CdpEvent>)
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
		sendAndWait: async <M extends CdpMethod>(method: M, params?: CdpParams<M>, commandOptions?: CdpSendOptions) => {
			const currentSession = options.requireCurrentSession()
			let targetContext = options.getTargetContext()
			let nextParams = params
			let nextCommandOptions = commandOptions
			if (options.prepareCommand) {
				const prepared = await options.prepareCommand({
					method,
					params,
					commandOptions,
					targetContext,
				} as PreparedCdpCommand)
				// prepareCommand returns params for whichever method it was handed, so the
				// union it declares collapses back to this call's method.
				nextParams = (prepared?.params as CdpParams<M> | undefined) ?? params
				nextCommandOptions = prepared?.commandOptions ?? commandOptions
				targetContext = prepared?.targetContext ?? targetContext
			}
			const nextOptions =
				targetContext.kind === 'frame' && targetContext.sessionId
					? { ...(nextCommandOptions ?? {}), sessionId: targetContext.sessionId }
					: nextCommandOptions
			return currentSession.handle.sendAndWait(method, nextParams, nextOptions)
		},
		onEvent: (method, handler) => {
			const subscription = createDelegatingEventSubscription(method, handler as CdpEventHandler<never>)
			subscriptions.add(subscription)
			controller.rebind()

			return () => {
				subscription.unbind()
				subscriptions.delete(subscription)
			}
		},
		getTargetContext: options.getTargetContext,
		// A session with no recovery step is ready as soon as its context resolves.
		getReadyTargetContext: options.getReadyTargetContext ?? (async () => options.getTargetContext()),
	}

	controller.rebind()
	return { session, controller }
}

const createDelegatingEventSubscription = (method: CdpEvent, handler: CdpEventHandler<never>): DelegatingEventSubscription => ({
	method,
	handler,
	off: null,
	unbind() {
		this.off?.()
		this.off = null
	},
})
