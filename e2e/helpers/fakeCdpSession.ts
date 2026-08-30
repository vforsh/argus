import type {
	CdpEvent,
	CdpEventHandler,
	CdpEventMeta,
	CdpEventPayload,
	CdpMethod,
	CdpParams,
	CdpResult,
	CdpSendOptions,
	CdpSessionHandle,
	CdpTargetContext,
} from '@vforsh/argus-watcher/internal'

/** One command the fake received. */
export type FakeCdpCall = { method: string; params: Record<string, unknown> }

export type FakeCdpSession = CdpSessionHandle & {
	/** Commands received, in order. */
	readonly calls: FakeCdpCall[]
	/** Just the method names — enough for "did this take the extra round-trip?" assertions. */
	readonly methods: string[]
	/** Push an event to every handler registered for it. */
	emit: <E extends CdpEvent>(method: E, params: CdpEventPayload<E>, meta?: CdpEventMeta) => void
}

export type FakeCdpSessionOptions = {
	/**
	 * Answer one command. Return `undefined` to fall through to `{}`.
	 *
	 * Receives the fake itself so a responder can emit events as a side effect (the way
	 * `Page.startScreencast` produces frames).
	 */
	respond?: (method: string, params: Record<string, unknown>, session: FakeCdpSession) => unknown
	/** What `getTargetContext`/`getReadyTargetContext` report. Defaults to a page-scoped context. */
	targetContext?: CdpTargetContext
	/** What `isAttached` reports. Defaults to `true`. */
	attached?: boolean
}

/**
 * A `CdpSessionHandle` backed by canned responses.
 *
 * One shared implementation so the generic `sendAndWait`/`onEvent` signatures are satisfied in
 * exactly one place: hand-rolled stubs kept drifting from the interface, and because they were only
 * exercised at runtime the drift surfaced as a mid-suite failure rather than a compile error.
 */
export const createFakeCdpSession = (options: FakeCdpSessionOptions = {}): FakeCdpSession => {
	const calls: FakeCdpCall[] = []
	const handlers = new Map<string, Set<CdpEventHandler>>()
	const targetContext = options.targetContext ?? { kind: 'page' }

	const session: FakeCdpSession = {
		calls,
		get methods() {
			return calls.map((call) => call.method)
		},

		isAttached: () => options.attached ?? true,

		sendAndWait: async <M extends CdpMethod>(method: M, params?: CdpParams<M>, _options?: CdpSendOptions): Promise<CdpResult<M>> => {
			calls.push({ method, params: (params as Record<string, unknown> | undefined) ?? {} })
			const response = options.respond?.(method, (params as Record<string, unknown> | undefined) ?? {}, session)
			// Canned payloads are authored per test; the protocol map cannot narrow them.
			return (response ?? {}) as CdpResult<M>
		},

		onEvent: <E extends CdpEvent>(method: E, handler: CdpEventHandler<E>): (() => void) => {
			let bucket = handlers.get(method)
			if (!bucket) {
				bucket = new Set()
				handlers.set(method, bucket)
			}
			const erased = handler as CdpEventHandler
			bucket.add(erased)
			return () => {
				bucket?.delete(erased)
			}
		},

		emit: <E extends CdpEvent>(method: E, params: CdpEventPayload<E>, meta: CdpEventMeta = { sessionId: null }): void => {
			for (const handler of handlers.get(method) ?? []) {
				handler(params as CdpEventPayload<CdpEvent>, meta)
			}
		},

		getTargetContext: () => targetContext,
		getReadyTargetContext: async () => targetContext,
	}

	return session
}
