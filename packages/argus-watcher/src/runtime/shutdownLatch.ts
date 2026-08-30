/**
 * Close-once, even when the request beats the close routine into existence.
 *
 * The HTTP server can receive `POST /shutdown` while `startHttpServer` is still on the stack, before
 * the runtime has built the routine that tears everything down. That used to be four cooperating
 * flags (`closing`, `readyForShutdown`, `shutdownRequested`, and a nullable `closeOnce`); it is one
 * promise now — the latch resolves when the routine is armed, and every caller awaits the same run.
 */
export type ShutdownLatch = {
	/** Publish the teardown routine. A shutdown that already arrived runs as soon as this lands. */
	arm: (close: () => Promise<void>) => void
	/** Run teardown exactly once, waiting for {@link arm} if the request got there first. */
	close: () => Promise<void>
}

export const createShutdownLatch = (): ShutdownLatch => {
	let arm!: (close: () => Promise<void>) => void
	const armed = new Promise<() => Promise<void>>((resolve) => {
		arm = resolve
	})
	let running: Promise<void> | null = null

	return {
		arm: (close) => {
			arm(close)
		},
		close: async () => {
			running ??= armed.then((run) => run())
			await running
		},
	}
}
