import { visibilityRequestSchema, type VisibilityPolicy, type VisibilityRequest, type VisibilityResponse } from '@vforsh/argus-core'
import { defineWatcherCommand } from '../cli/defineWatcherCommand.js'
import { createOutput } from '../output/io.js'
import type { Output } from '../output/io.js'
import { resolveWatcherOrExit, writeErrorResponse } from '../watchers/requestWatcher.js'
import { formatError } from '../cli/parse.js'
import { requestVisibility } from './visibility.js'

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
	formatHuman: (data, { output, watcher, args: [action] }) => renderVisibility(data, watcher.id, action, output),
})

/** Policy-aware writes must verify that the watcher supports GET /visibility before mutating it. */
const visibilityAction = async (id: string | undefined, action: PageVisibilityAction, options: PageVisibilityOptions): Promise<void> => {
	if (options.policy == null && options.activate !== false) {
		await visibilityRunner(id, action, options)
		return
	}

	const output = createOutput({ ...options, json: options.json === true })
	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return
	try {
		const data = await requestVisibility(resolved.watcher, {
			action,
			policy: options.policy,
			...(options.activate === false ? { activate: false } : {}),
		})
		if (!data.ok) {
			writeErrorResponse(data, output)
			return
		}
		if (output.json) {
			output.writeJson(data)
			return
		}
		renderVisibility(data, resolved.watcher.id, action, output)
	} catch (error) {
		writeErrorResponse({ ok: false, error: { message: formatError(error) } }, output)
	}
}

const renderVisibility = (data: VisibilityResponse, watcherId: string, action: PageVisibilityAction, output: Output): void => {
	if (!data.attached) {
		const suffix = action === 'show' ? ' (will apply on reattach)' : ''
		output.writeHuman(`page ${action} queued for ${watcherId}${suffix}`)
		return
	}
	output.writeHuman(`${data.state === 'shown' ? 'shown' : 'hidden'} ${watcherId}`)
}

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
