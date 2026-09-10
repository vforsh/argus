import {
	VISIBILITY_POLICIES,
	visibilityRequestSchema,
	type ApiResult,
	type ErrorResponse,
	type VisibilityPolicy,
	type VisibilityRequest,
	type VisibilityResponse,
} from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { createOutput } from '../output/io.js'
import { requestWatcherJson, writeErrorResponse, writeRequestError } from '../watchers/requestWatcher.js'

/** Shared flags for `argus page show` / `argus page hide`. */
export type PageVisibilityOptions = {
	json?: boolean
	policy?: VisibilityPolicy
	/** Commander sets this to true when `--no-activate` is omitted; only false is sent. */
	activate?: boolean
}

/** Options for `argus page visibility`. */
export type PageVisibilityStatusOptions = { json?: boolean }

type PageVisibilityAction = 'show' | 'hide'

/** Internal runner — the public `runPageShow`/`runPageHide` wrappers thread the action through as a positional arg. */
const visibilityRunner = defineWatcherCommand<PageVisibilityOptions, VisibilityResponse, VisibilityRequest, [action: PageVisibilityAction]>({
	build: ([action], options) => ({
		path: '/visibility',
		method: 'POST',
		body: {
			action,
			...(options.policy == null ? {} : { policy: options.policy }),
			...(options.activate === false ? { activate: false } : {}),
		},
		timeoutMs: 5_000,
	}),
	schema: visibilityRequestSchema,
	formatHuman: (data, { output, watcher, args: [action] }) => {
		if (!data.attached) {
			// Desired state is remembered in the watcher; it will apply on reattach.
			const suffix = action === 'show' ? ' (will apply on reattach)' : ''
			output.writeHuman(`page ${action} queued for ${watcher.id}${suffix}`)
			return
		}
		output.writeHuman(`${data.state === 'shown' ? 'shown' : 'hidden'} ${watcher.id}`)
	},
})

/** Policy-aware writes must verify that the watcher supports GET /visibility before mutating it. */
const visibilityAction = async (id: string | undefined, action: PageVisibilityAction, options: PageVisibilityOptions): Promise<void> => {
	if (options.policy == null && options.activate !== false) {
		await visibilityRunner(id, action, options)
		return
	}

	const output = createOutput({ ...options, json: options.json === true })
	const result = await requestWatcherJson<ApiResult<VisibilityResponse>>({
		id,
		path: '/visibility',
		method: 'GET',
		timeoutMs: 5_000,
		returnErrorResponse: true,
	})
	if (!result.ok) {
		writeRequestError(result, output)
		return
	}

	if (!isVisibilityStatusResponse(result.data)) {
		writeErrorResponse(unsupportedVisibilityResponse(result.watcher.id), output)
		return
	}

	// Use the resolved watcher id for both calls so an omitted id or a registry alias cannot drift
	// between the compatibility check and the mutation.
	await visibilityRunner(result.watcher.id, action, options)
}

const isVisibilityStatusResponse = (value: unknown): value is VisibilityResponse => {
	if (value == null || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) return false
	const response = value as { attached?: unknown; state?: unknown; policy?: unknown }
	return (
		typeof response.attached === 'boolean' &&
		(response.state === 'shown' || response.state === 'default') &&
		VISIBILITY_POLICIES.includes(response.policy as VisibilityPolicy)
	)
}

const unsupportedVisibilityResponse = (watcherId: string): ErrorResponse => ({
	ok: false,
	error: {
		code: 'not_available',
		message: `Watcher ${watcherId} does not support visibility policy checks. Restart or update the watcher, then retry.`,
	},
})

/** `argus page visibility <id>` — read the desired lock and policy without mutating state. */
export const runPageVisibilityStatus = defineWatcherCommand<PageVisibilityStatusOptions, VisibilityResponse>({
	build: () => ({ path: '/visibility', method: 'GET', timeoutMs: 5_000 }),
	formatHuman: (data, { output }) => {
		output.writeHuman(`attached: ${data.attached}\nstate:    ${data.state}\npolicy:   ${data.policy}`)
	},
})

/** `argus page show <id>` — lock the page into shown+focused state. */
export const runPageShow = (id: string | undefined, options: PageVisibilityOptions): Promise<void> => visibilityAction(id, 'show', options)

/** `argus page hide <id>` — release the visibility lock. */
export const runPageHide = (id: string | undefined, options: PageVisibilityOptions): Promise<void> => visibilityAction(id, 'hide', options)
