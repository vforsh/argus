import { afterEach } from 'bun:test'

/**
 * Returns `defer(fn)`: teardown registered during a test runs after it, newest first, pass or fail.
 * Newest-first matters when a session must close before the stub watcher it talks to.
 */
export const useCleanup = (): ((fn: () => unknown) => void) => {
	const stack: Array<() => unknown> = []
	afterEach(async () => {
		for (const fn of stack.splice(0).reverse()) await fn()
	})
	return (fn) => {
		stack.push(fn)
	}
}
