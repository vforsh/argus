import { AsyncLocalStorage } from 'node:async_hooks'

/** Exit code reported inside one {@link runWithExitCodeScope} call; `undefined` until something fails. */
export type ExitCodeScope = { exitCode?: number }

const scopes = new AsyncLocalStorage<ExitCodeScope>()

/**
 * Report a command's failure exit code.
 *
 * Outside a scope this is plain `process.exitCode = code`, which is all a one-shot CLI needs.
 * Inside {@link runWithExitCodeScope} the code lands on that scope instead: `argus session` runs
 * dialog controls while another request is still in flight, and `process.exitCode` would hand
 * one request's failure to the other. Making the global itself async-local is not an option —
 * it is a non-configurable accessor in both Node and Bun.
 *
 * Shared watcher-command plumbing reports through here, which covers every command the session
 * runs concurrently. Commands that still assign `process.exitCode` directly are correct on the
 * session's serial lane only.
 */
export const setExitCode = (code: number): void => {
	const scope = scopes.getStore()
	if (scope) {
		scope.exitCode = code
		return
	}
	process.exitCode = code
}

/**
 * Run `body` with {@link setExitCode} writing into `scope`.
 *
 * The scope follows the async context, so a command abandoned by a watchdog keeps reporting into
 * its own scope rather than whichever request runs next.
 */
export const runWithExitCodeScope = <T>(scope: ExitCodeScope, body: () => Promise<T>): Promise<T> => scopes.run(scope, body)
