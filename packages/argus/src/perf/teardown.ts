import { withRequestContext } from '../session/requestContext.js'

/**
 * Own the teardown of page/browser state a perf command created (recorder, trace).
 *
 * Teardown runs in a fresh request scope: inside `argus session` the command's own deadline or
 * cancellation may already have fired, and inheriting it would skip the uninstall/stop requests
 * entirely, leaving listeners in the page and Chrome's single trace slot taken. It also runs on
 * SIGINT/SIGTERM, so Ctrl+C during an armed capture cleans up before the process exits.
 */
export const createTeardown = () => {
	const steps: (() => Promise<unknown>)[] = []
	let running: Promise<void> | null = null

	const run = (): Promise<void> => {
		running ??= withRequestContext({}, async () => {
			for (const step of steps.splice(0).reverse()) await step().catch(() => undefined)
		})
		return running
	}

	const onSignal = (signal: NodeJS.Signals): void => {
		void run().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
	}
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)

	return {
		/** Register a step; steps run in reverse registration order. */
		add: (step: () => Promise<unknown>): void => {
			steps.push(step)
		},
		/** Remove a step that already ran on the normal path. */
		remove: (step: () => Promise<unknown>): void => {
			const index = steps.indexOf(step)
			if (index !== -1) steps.splice(index, 1)
		},
		/** Forget every step (the normal path took over). */
		clear: (): void => {
			steps.length = 0
		},
		/** Run what is left and stop listening for signals. */
		dispose: async (): Promise<void> => {
			process.off('SIGINT', onSignal)
			process.off('SIGTERM', onSignal)
			await run()
		},
	}
}
