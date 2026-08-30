import type { CdpMethod, CdpParams } from '../cdp/protocol.js'
import type { NetMockScope } from '@vforsh/argus-core'
import type { CdpEventMeta, CdpSessionHandle } from '../cdp/connection.js'
import { hasErrorCode } from '../errors.js'

/** CDP routing information for the target currently selected by the watcher. */
export type NetMockSelectedTarget = {
	frameId: string | null
	topFrameId: string | null
	sessionId: string | null
}

/** Normalized `Fetch.requestPaused` event with the originating CDP session. */
export type NetMockPausedRequest = {
	requestId: string
	url: string
	method: string
	resourceType: string
	frameId: string | null
	sessionId: string | null
	headers: Record<string, string>
}

/** Stable CDP session and dynamic selected-target lookup used by interception. */
export type NetMockInterceptionBinding = {
	/** Stable top-level session; child-target commands are routed with explicit CDP session ids. */
	pageSession: CdpSessionHandle
	/** Resolves the currently selected target each time so `selected` rules follow iframe selection. */
	getSelectedTarget: () => NetMockSelectedTarget | null
}

type InterceptionTarget = {
	key: string
	sessionId: string | null
}

type FetchRequestPausedParams = {
	requestId?: string
	request?: {
		url?: string
		method?: string
		headers?: Record<string, string>
	}
	resourceType?: string
	frameId?: string
}

const PAGE_TARGET: InterceptionTarget = { key: 'page', sessionId: null }

/** Owns Fetch-domain lifecycle across the top-level page and the currently selected iframe target. */
export class NetMockInterception {
	private binding: NetMockInterceptionBinding | null = null
	private bound = false
	private readonly enabledTargets = new Map<string, InterceptionTarget>()
	private reconcileTail: Promise<void> = Promise.resolve()

	public constructor(
		private readonly onPaused: (request: NetMockPausedRequest) => void,
		private readonly onError: (error: unknown) => void,
	) {}

	public bind(binding: NetMockInterceptionBinding): void {
		this.binding = binding
		if (this.bound) {
			return
		}

		this.bound = true
		binding.pageSession.onEvent('Fetch.requestPaused', (params, meta) => {
			const request = parsePausedRequest(params, meta)
			if (request) {
				this.onPaused(request)
			}
		})
	}

	public get enabled(): boolean {
		return this.enabledTargets.size > 0
	}

	public matchesScope(scope: NetMockScope, request: NetMockPausedRequest): boolean {
		if (scope === 'page') {
			return request.sessionId === null
		}

		const selected = this.binding?.getSelectedTarget() ?? null
		if (selected?.sessionId) {
			return request.sessionId === selected.sessionId
		}
		if (request.sessionId !== null) {
			return false
		}

		const selectedFrameId = selected?.frameId ?? null
		const selectedIsChildFrame = selectedFrameId !== null && selectedFrameId !== selected?.topFrameId
		return !selectedIsChildFrame || request.frameId === selectedFrameId
	}

	public async sendRequestCommand<M extends CdpMethod>(request: NetMockPausedRequest, method: M, params: CdpParams<M>): Promise<void> {
		await this.sendCommand({ key: request.sessionId ? `session:${request.sessionId}` : 'page', sessionId: request.sessionId }, method, params)
	}

	public reconcile(scopes: ReadonlySet<NetMockScope>, reset = false): Promise<boolean> {
		const requestedScopes = new Set(scopes)
		const operation = this.reconcileTail.then(() => this.applyReconcile(requestedScopes, reset))
		// Target-change events can arrive while CDP commands are in flight. Keep
		// lifecycle mutations ordered so an older iframe cannot remain enabled.
		this.reconcileTail = operation.then(
			() => undefined,
			() => undefined,
		)
		return operation
	}

	private async applyReconcile(scopes: ReadonlySet<NetMockScope>, reset: boolean): Promise<boolean> {
		if (reset) {
			// A fresh underlying attachment invalidates old session ids; there is nothing useful to disable.
			this.enabledTargets.clear()
		}

		const session = this.binding?.pageSession
		if (!session?.isAttached()) {
			this.enabledTargets.clear()
			return false
		}

		const desiredTargets = this.getDesiredTargets(scopes)
		for (const [key, target] of this.enabledTargets) {
			if (!desiredTargets.has(key)) {
				await this.sendCommand(target, 'Fetch.disable')
				this.enabledTargets.delete(key)
			}
		}

		for (const [key, target] of desiredTargets) {
			if (this.enabledTargets.has(key)) {
				continue
			}
			const enabled = await this.sendCommand(target, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
			if (enabled) {
				this.enabledTargets.set(key, target)
			}
		}

		return this.enabled
	}

	public onDetach(): void {
		this.enabledTargets.clear()
	}

	private getDesiredTargets(scopes: ReadonlySet<NetMockScope>): Map<string, InterceptionTarget> {
		const targets = new Map<string, InterceptionTarget>()
		if (scopes.has('page')) {
			targets.set(PAGE_TARGET.key, PAGE_TARGET)
		}
		if (!scopes.has('selected')) {
			return targets
		}

		const sessionId = this.binding?.getSelectedTarget()?.sessionId ?? null
		const selectedTarget = sessionId ? { key: `session:${sessionId}`, sessionId } : PAGE_TARGET
		targets.set(selectedTarget.key, selectedTarget)
		return targets
	}

	private async sendCommand<M extends CdpMethod>(
		target: InterceptionTarget,
		method: M,
		params: CdpParams<M> = {} as CdpParams<M>,
	): Promise<boolean> {
		const session = this.binding?.pageSession
		if (!session?.isAttached()) {
			return false
		}

		try {
			await session.sendAndWait(method, params, target.sessionId ? { sessionId: target.sessionId } : undefined)
			return true
		} catch (error) {
			if (!isBenignInterceptionError(error)) {
				this.onError(error)
			}
			return false
		}
	}
}

const parsePausedRequest = (params: unknown, meta: CdpEventMeta): NetMockPausedRequest | null => {
	const paused = params as FetchRequestPausedParams
	const requestId = paused?.requestId
	if (typeof requestId !== 'string' || requestId === '') {
		return null
	}

	return {
		requestId,
		url: paused.request?.url ?? '',
		method: paused.request?.method ?? 'GET',
		resourceType: paused.resourceType ?? '',
		frameId: paused.frameId ?? null,
		sessionId: meta.sessionId ?? null,
		headers: paused.request?.headers ?? {},
	}
}

const isBenignInterceptionError = (error: unknown): boolean => {
	if (hasErrorCode(error, 'cdp_not_attached')) {
		return true
	}
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes('Invalid InterceptionId') ||
		message.includes('Inspected target navigated or closed') ||
		message.includes('Session with given id not found') ||
		message.includes('No target with given id')
	)
}
