import { formatError } from '../cli/parse.js'
import { forwardSocket, listForwards, readDevtoolsState, removeForward } from './adb.js'

const POLL_INTERVAL_MS = 2_000

export type ForwardSupervisorOptions = {
	serial: string
	packageName: string
	/** Host port this attach owns. It never changes, so the watcher reconnects to the same endpoint. */
	port: number
	/** Socket the forward points at when supervision starts. */
	socket: string
	log: (message: string) => void
}

export type ForwardSupervisor = {
	readonly socket: string
	/** Stop polling and remove this attach's forward, and only it. */
	stop: () => Promise<void>
}

/**
 * Keep one host port forwarded to the package's current DevTools socket.
 *
 * A WebView socket is named after its process (`webview_devtools_remote_<pid>`), so every app
 * restart strands a plain `adb forward`. Re-pointing the *same* host port at the new socket is all
 * a reattach needs: the watcher's own reconnect loop finds the page again on its next attempt.
 * The forward table is checked too, because a device reconnect drops every forward silently.
 */
export const startForwardSupervisor = (options: ForwardSupervisorOptions): ForwardSupervisor => {
	const { serial, packageName, port, log } = options
	let socket = options.socket
	let stopped = false
	let timer: NodeJS.Timeout | null = null
	let inFlight: Promise<void> | null = null
	let lastProblem: string | null = null

	const reportProblem = (problem: string): void => {
		if (problem !== lastProblem) log(problem)
		lastProblem = problem
	}

	const tick = async (): Promise<void> => {
		const state = await readDevtoolsState(serial, packageName)
		if (!state.socket) {
			reportProblem(
				state.pids.length === 0
					? `${packageName} is not running; waiting for it to start`
					: `${packageName} (pid ${state.pids.join(',')}) has no WebView DevTools socket yet; waiting`,
			)
			return
		}

		const forwards = await listForwards()
		const ours = forwards.find((forward) => forward.serial === serial && forward.local === `tcp:${port}`)
		const wanted = `localabstract:${state.socket}`
		if (ours?.remote === wanted) {
			if (lastProblem) log(`forward tcp:${port} → ${state.socket} is healthy again`)
			lastProblem = null
			return
		}

		if (stopped) return
		await forwardSocket(serial, port, state.socket)
		const reason = state.socket !== socket ? `app restarted (pid ${state.pids.join(',')})` : 'forward was missing'
		log(`${reason}; re-pointed tcp:${port} → ${state.socket}`)
		socket = state.socket
		lastProblem = null
	}

	const schedule = (): void => {
		if (stopped) return
		timer = setTimeout(() => {
			inFlight = tick()
				.catch((error) => reportProblem(`device check failed: ${formatError(error)}; retrying`))
				.finally(() => {
					inFlight = null
					schedule()
				})
		}, POLL_INTERVAL_MS)
	}
	schedule()

	return {
		get socket() {
			return socket
		},
		stop: async () => {
			stopped = true
			if (timer) clearTimeout(timer)
			// A tick mid-flight could otherwise re-create the forward right after it is removed.
			await inFlight
			try {
				await removeForward(serial, port)
			} catch {
				// Already gone: device disconnected or the forward was removed by hand.
			}
		},
	}
}
