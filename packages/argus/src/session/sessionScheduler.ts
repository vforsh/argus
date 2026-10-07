import { setTimeout as sleep } from 'node:timers/promises'

/** One request's work. It writes its own response, so the scheduler only decides when it starts. */
export type SessionTask = () => Promise<void>

/** Decides when each submitted request may start. See {@link createSessionScheduler}. */
export type SessionScheduler = {
	/** Queue an ordinary request: it starts once every request submitted before it has finished. */
	ordered: (task: SessionTask) => void
	/**
	 * Queue a dialog control (`dialog status|accept|dismiss|prompt`). It starts once every request
	 * submitted before it has finished — or earlier, once the only unfinished one ahead is the
	 * in-flight ordinary request and the page shows a JavaScript dialog.
	 */
	control: (task: SessionTask) => void
	/** Resolve once every request submitted so far has finished. */
	drain: () => Promise<void>
}

export type SessionSchedulerInput = {
	/** Whether the page currently shows a JavaScript dialog. Must not throw; report `false` when unsure. */
	dialogOpen: () => Promise<boolean>
	/** Called with anything a task throws; a task failure never stalls the requests behind it. */
	onError: (error: unknown) => void
	/** Delay between dialog probes while a control waits on an in-flight request. */
	pollMs?: number
}

const DEFAULT_DIALOG_POLL_MS = 100

type OrderedEntry = { started: Promise<void>; settled: Promise<void> }

/**
 * Order session requests without letting a native dialog deadlock its own handler.
 *
 * A click or eval that opens `confirm()` does not return until the dialog closes, so a strictly
 * serial session would park `dialog accept` behind the very request waiting for it. Dialog
 * controls therefore get one exception: they may overtake the in-flight request, but only while
 * a dialog is actually open. Dispatching them immediately instead would race the click — the
 * control could reach the watcher before the dialog exists and report nothing to handle.
 *
 * Everything else keeps submission order: ordinary requests wait for every earlier request,
 * controls included, and controls run one at a time. A control never overtakes ordinary requests
 * that are still queued, only the one in flight; queuing requests behind a dialog-opening one
 * and the control behind those is a host-side deadlock the request watchdog resolves.
 */
export const createSessionScheduler = (input: SessionSchedulerInput): SessionScheduler => {
	const pollMs = input.pollMs ?? DEFAULT_DIALOG_POLL_MS
	const runSafely = (task: SessionTask): Promise<void> => task().catch(input.onError)

	let everything: Promise<void> = Promise.resolve()
	let lastOrdered: OrderedEntry | null = null
	let lastControl: Promise<void> = Promise.resolve()

	/**
	 * Resolve once `blocker` is the only unfinished request ahead and a dialog is open — or once
	 * `blocker` finishes, at which point everything ahead has finished too.
	 */
	const blockedByDialog = async (blocker: OrderedEntry, controlsAhead: Promise<void>): Promise<void> => {
		let finished = false
		void blocker.settled.then(() => {
			finished = true
		})

		await Promise.all([blocker.started, controlsAhead])
		while (!finished) {
			if (await input.dialogOpen()) return
			await Promise.race([sleep(pollMs), blocker.settled])
		}
	}

	return {
		ordered: (task) => {
			let markStarted!: () => void
			const started = new Promise<void>((resolve) => {
				markStarted = resolve
			})
			const settled = everything.then(() => {
				markStarted()
				return runSafely(task)
			})

			lastOrdered = { started, settled }
			// An ordered request starts after everything before it, so its end is everyone's end.
			everything = settled
		},
		control: (task) => {
			const ahead = everything
			const ready = lastOrdered ? Promise.race([ahead, blockedByDialog(lastOrdered, lastControl)]) : ahead
			const settled = ready.then(() => runSafely(task))

			lastControl = settled
			everything = Promise.all([ahead, settled]).then(() => {})
		},
		drain: () => everything,
	}
}
