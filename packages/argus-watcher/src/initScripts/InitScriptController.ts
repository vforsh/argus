import type {
	ErrorDetail,
	InitScript,
	InitScriptAddRequest,
	InitScriptAddResponse,
	InitScriptClearResponse,
	InitScriptRemoveResponse,
	InitScriptStatusResponse,
} from '@vforsh/argus-core'
import { formatError } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'
import { getErrorCode } from '../errors.js'

type InternalScript = {
	id: number
	name?: string
	source: string
	bytes: number
	createdAt: number
	/** CDP identifier on the current attachment; null until registered (or after detach). */
	identifier: string | null
}

/**
 * Runtime-managed `Page.addScriptToEvaluateOnNewDocument` scripts.
 *
 * Scripts live in the watcher and are re-registered on every attach, so they keep running before
 * page scripts across reloads, navigations, and target restarts. CDP identifiers are per attachment:
 * a detach forgets them, and the next attach registers every script again in insertion order.
 * Operations are serialized so an add racing a reattach can never register a script twice.
 */
export type InitScriptController = {
	/** Provide the page session scripts are registered on. Call once at startup. */
	bind: (session: CdpSessionHandle) => void
	getStatus: (ctx: { attached: boolean }) => InitScriptStatusResponse
	add: (input: InitScriptAddRequest, attached: boolean) => Promise<InitScriptAddResponse>
	remove: (id: number) => Promise<InitScriptRemoveResponse>
	clear: () => Promise<InitScriptClearResponse>
	/** Register every script on a freshly attached target. */
	onAttach: () => Promise<void>
	/** Forget per-attachment identifiers after the target detached. */
	onDetach: () => void
}

export const createInitScriptController = (): InitScriptController => {
	let session: CdpSessionHandle | null = null
	let lastError: ErrorDetail | null = null
	let nextId = 1
	const scripts: InternalScript[] = []
	let tail: Promise<unknown> = Promise.resolve()

	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation, operation)
		tail = result.catch(() => undefined)
		return result
	}

	const recordError = (error: unknown): void => {
		lastError = { message: formatError(error) }
		const code = getErrorCode(error)
		if (code) {
			lastError.code = code
		}
	}

	const register = async (script: InternalScript, runImmediately: boolean): Promise<boolean> => {
		if (!session?.isAttached()) {
			return false
		}
		try {
			const result = await session.sendAndWait('Page.addScriptToEvaluateOnNewDocument', {
				source: script.source,
				...(runImmediately ? { runImmediately: true } : {}),
			})
			script.identifier = result.identifier ?? null
			return true
		} catch (error) {
			recordError(error)
			return false
		}
	}

	const unregister = async (script: InternalScript): Promise<void> => {
		const identifier = script.identifier
		script.identifier = null
		if (!identifier || !session?.isAttached()) {
			return
		}
		try {
			await session.sendAndWait('Page.removeScriptToEvaluateOnNewDocument', { identifier })
		} catch (error) {
			recordError(error)
		}
	}

	const add = (input: InitScriptAddRequest, attached: boolean): Promise<InitScriptAddResponse> =>
		serialize(async () => {
			lastError = null
			const script: InternalScript = {
				id: nextId++,
				name: input.name,
				source: input.source,
				bytes: Buffer.byteLength(input.source, 'utf8'),
				createdAt: Date.now(),
				identifier: null,
			}
			scripts.push(script)

			if (!attached) {
				return { ok: true, attached: false, script: toPublicScript(script) }
			}
			const registered = await register(script, input.runNow === true)
			return { ok: true, attached: true, script: toPublicScript(script), error: registered ? null : lastError }
		})

	const remove = (id: number): Promise<InitScriptRemoveResponse> =>
		serialize(async () => {
			const index = scripts.findIndex((script) => script.id === id)
			if (index < 0) {
				return { ok: true, removed: false }
			}
			const [script] = scripts.splice(index, 1)
			await unregister(script!)
			return { ok: true, removed: true }
		})

	const clear = (): Promise<InitScriptClearResponse> =>
		serialize(async () => {
			const removed = scripts.splice(0)
			for (const script of removed) {
				await unregister(script)
			}
			return { ok: true, removed: removed.length }
		})

	const onAttach = (): Promise<void> =>
		serialize(async () => {
			for (const script of scripts) {
				script.identifier = null
				if (!(await register(script, false)) && lastError) {
					console.warn(`[InitScript] Failed to register init script #${script.id} on attach: ${lastError.message}`)
				}
			}
		})

	const onDetach = (): void => {
		for (const script of scripts) {
			script.identifier = null
		}
	}

	return {
		bind: (pageSession) => {
			session = pageSession
		},
		getStatus: ({ attached }) => ({ ok: true, attached, scripts: scripts.map(toPublicScript), lastError }),
		add,
		remove,
		clear,
		onAttach,
		onDetach,
	}
}

const toPublicScript = (script: InternalScript): InitScript => ({
	id: script.id,
	...(script.name ? { name: script.name } : {}),
	bytes: script.bytes,
	registered: script.identifier != null,
	createdAt: script.createdAt,
})
