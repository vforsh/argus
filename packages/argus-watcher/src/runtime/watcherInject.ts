import { formatError, type WatcherRecord } from '@vforsh/argus-core'
import type { CdpSessionHandle } from '../cdp/connection.js'

export const buildInjectExpression = (
	script: string,
	argusPayload: {
		watcherId: string
		watcherHost: string
		watcherPort: number
		watcherPid: number
		attachedAt: number
		target: { title: string | null; url: string | null; type: string; parentId: string | null }
	} | null,
): string => {
	const lines = ['(() => {']
	if (argusPayload) {
		lines.push(`window.__ARGUS__ = ${JSON.stringify(argusPayload)};`)
	}
	lines.push(`const __argusScript = ${JSON.stringify(script)};`)
	lines.push('const __argusFn = new Function(__argusScript);')
	lines.push('__argusFn();')
	lines.push('})();')
	return lines.join('\n')
}

/** Options for the optional attach-time script injection. */
export type WatcherInjectOptions = {
	script: string
	exposeArgus?: boolean
}

/** Target metadata the injected `window.__ARGUS__` payload carries. */
type InjectTarget = { title?: string | null; url?: string | null; type?: string | null; parentId?: string | null }

/**
 * Build the attach hook that installs a watcher's `inject.script`.
 *
 * Returns a no-op when nothing is configured, so the runtime can call it unconditionally. The script
 * is registered for future documents *and* evaluated once against the page already loaded; a failure
 * on either is warned about but never fails the attach.
 *
 * @param record Live watcher record, read at call time for the `window.__ARGUS__` payload.
 */
export const createInjectOnAttach = (
	inject: WatcherInjectOptions | undefined,
	record: WatcherRecord,
): ((session: CdpSessionHandle, target: InjectTarget) => Promise<void>) => {
	if (!inject?.script) {
		return async () => {}
	}

	return async (session, target) => {
		if (!session.isAttached()) {
			return
		}

		const trimmedScript = inject.script.trim()
		if (trimmedScript === '') {
			console.warn(`[Watcher] Inject script is empty for watcher ${record.id}. Skipping.`)
			return
		}

		const argusPayload =
			inject.exposeArgus ?? true
				? {
						watcherId: record.id,
						watcherHost: record.host,
						watcherPort: record.port,
						watcherPid: record.pid,
						attachedAt: Date.now(),
						target: {
							title: target.title ?? null,
							url: target.url ?? null,
							type: target.type ?? 'page',
							parentId: target.parentId ?? null,
						},
					}
				: null

		const expression = buildInjectExpression(trimmedScript, argusPayload)

		await runInjectStep('register', record.id, () => session.sendAndWait('Page.addScriptToEvaluateOnNewDocument', { source: expression }))
		await runInjectStep('run', record.id, () => session.sendAndWait('Runtime.evaluate', { expression, silent: true }))
	}
}

const runInjectStep = async (step: 'register' | 'run', watcherId: string, action: () => Promise<unknown>): Promise<void> => {
	try {
		await action()
	} catch (error) {
		console.warn(`[Watcher] Failed to ${step} inject script for watcher ${watcherId}: ${formatError(error)}`)
	}
}
