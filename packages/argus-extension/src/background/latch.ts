/**
 * A one-shot latch: callers await a signal that fires at most once.
 *
 * Once {@link Latch.signal} has been called the latch stays open, so later `wait()`
 * calls resolve immediately. Pending waiters are dropped on timeout, so a timed-out
 * wait leaves no listener behind.
 */
export type Latch = {
	/** Whether {@link Latch.signal} has already fired. */
	readonly isOpen: boolean
	/** Resolve once the latch is open, or reject with `timeoutMessage` after `timeoutMs`. */
	wait: (timeoutMs: number, timeoutMessage: string) => Promise<void>
	/** Open the latch and release every pending waiter. Idempotent. */
	signal: () => void
}

/** Create a {@link Latch}. */
export const createLatch = (): Latch => {
	let open = false
	let waiters: Array<() => void> = []

	return {
		get isOpen(): boolean {
			return open
		},

		wait: (timeoutMs, timeoutMessage) => {
			if (open) {
				return Promise.resolve()
			}

			return new Promise<void>((resolve, reject) => {
				const onOpen = (): void => {
					clearTimeout(timer)
					resolve()
				}
				const timer = setTimeout(() => {
					waiters = waiters.filter((waiter) => waiter !== onOpen)
					reject(new Error(timeoutMessage))
				}, timeoutMs)
				waiters.push(onOpen)
			})
		},

		signal: () => {
			open = true
			const pending = waiters
			waiters = []
			for (const waiter of pending) {
				waiter()
			}
		},
	}
}
