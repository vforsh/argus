import readline from 'node:readline'
import type { Command } from 'commander'
import type {
	DialogStatusResponse, SessionOutputLine, SessionReadyEvent, SessionRequest, SessionRequestId, SessionResponse, WatcherRecord,
} from '@vforsh/argus-core'
import {
	SESSION_PROTOCOL_VERSION, SESSION_REQUEST_SCHEMA, formatError, formatProtocolValidationIssues, parseDurationMs, createWatcherResolver, type WatcherResolver,
} from '@vforsh/argus-core'
import packageJson from '../../package.json' with { type: 'json' }
import { defineCommands } from '../cli/defineCommand.js'
import { createProgram } from '../cli/program.js'
import { dialogCommands } from '../cli/register/dialogCommands.js'
import { coreProgramRegistrars } from '../cli/register/index.js'
import { createPluginLoader, type PluginLoader } from '../cli/plugins/registerPlugins.js'
import { usageError } from '../cli/validation.js'
import { createOutput, routeConsoleToStderr, type Output } from '../output/io.js'
import { fetchWatcherJson, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { resolveWatcher, withWatcherResolver } from '../watchers/resolveWatcher.js'
import { resolveSessionCommand } from './sessionArgv.js'
import { dispatchSessionRequest } from './sessionDispatch.js'
import { createSessionScheduler } from './sessionScheduler.js'
import { installStdioCapture } from './stdioCapture.js'

export type RunSessionOptions = {
	json?: boolean
	requestTimeout?: string
	reconnect?: boolean
}

/** Watchdog applied to a request that does not carry its own `timeout`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** How long the liveness probe waits before calling the watcher gone. */
const WATCHER_PROBE_TIMEOUT_MS = 1_500

/** How long one "is a dialog open?" probe may take while a dialog control waits. */
const DIALOG_PROBE_TIMEOUT_MS = 1_000

/**
 * Serve JSONL commands over stdin/stdout against one watcher, in one process.
 *
 * A harness that drives a page through dozens of steps pays Node startup plus watcher
 * discovery on every one-shot `argus` invocation. This keeps both: the command tree is
 * built once, the watcher is resolved once, and each request runs the very same Commander
 * action the one-shot CLI would have run.
 */
export const runSession = async (id: string | undefined, options: RunSessionOptions): Promise<void> => {
	// stdout carries nothing but responses, so incidental `console.log` has to move before
	// any plugin gets a chance to write one.
	routeConsoleToStderr()

	const output = createOutput({ json: true })

	const defaultTimeoutMs = resolveDefaultTimeout(options, output)
	if (defaultTimeoutMs == null) return

	const resolved = await resolveWatcherOrExit({ id }, output)
	if (!resolved) return

	const { program, plugins } = await buildSessionProgram()
	const controlProgram = buildDialogControlProgram()
	const capture = installStdioCapture()
	const writeLine = (line: SessionOutputLine): void => capture.writeStdout(`${JSON.stringify(line)}\n`)

	writeLine(readyEvent(resolved.watcher))

	const resolver = createWatcherResolver()
	const exitCode = await withWatcherResolver(resolver, () => serveRequests({
		program,
		controlProgram,
		plugins,
		capture,
		writeLine,
		output,
		watcher: resolved.watcher,
		defaultTimeoutMs,
		reconnect: options.reconnect === true,
		resolver,
	}))

	capture.restore()
	await flushStdout()
	// A command abandoned by its watchdog can still hold a socket open; exit rather than
	// wait for an event loop the session no longer controls.
	process.exit(exitCode)
}

type ServeInput = {
	resolver: WatcherResolver
	program: Command
	/** Separate tree for dialog controls, which may parse while `program` is mid-parse. */
	controlProgram: Command
	plugins: PluginLoader
	capture: ReturnType<typeof installStdioCapture>
	writeLine: (line: SessionOutputLine) => void
	output: Output
	watcher: WatcherRecord
	defaultTimeoutMs: number
	reconnect: boolean
}

/**
 * Read one request per line until stdin ends, a `quit` arrives, or the watcher is lost.
 *
 * Requests run in submission order. Pipelining is still worth it — the host can keep writing
 * while a command is in flight — but ordering keeps `process.exitCode`, which is how ~200
 * commands report failure, meaningful for one request at a time. The one exception is a dialog
 * control, which may overtake an in-flight request that is blocked on a native dialog
 * ({@link createSessionScheduler}); it parses on its own command tree and reports its exit code
 * through a request scope, so neither request sees the other's state.
 */
const serveRequests = async (input: ServeInput): Promise<number> => {
	const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

	// Set once the session decided to end; requests still queued behind that point stay unanswered.
	let exitCode: number | null = null
	let markClosed!: () => void
	const closed = new Promise<void>((resolve) => {
		markClosed = resolve
	})
	const close = (code: number): void => {
		if (exitCode != null) return
		exitCode = code
		lines.close()
		markClosed()
	}
	const answer = (response: SessionResponse): void => {
		if (exitCode == null) input.writeLine(response)
	}

	const scheduler = createSessionScheduler({
		dialogOpen: () => dialogOpen(input.watcher.id),
		onError: (error) => input.output.writeWarn(`Session request failed unexpectedly: ${formatError(error)}`),
	})

	const run = (request: SessionRequest, control: boolean) => async (): Promise<void> => {
		if (exitCode != null) return

		const response = await dispatchSessionRequest({
			program: control ? input.controlProgram : input.program,
			// Dialog commands are built in; plugins never need loading for the control tree.
			prepare: control ? undefined : () => input.plugins.prepare(request.cmd.trim().split(/\s+/)),
			capture: input.capture,
			request,
			watcherId: input.watcher.id,
			defaultTimeoutMs: input.defaultTimeoutMs,
			ownsProcessExitCode: !control,
		})
		answer(response)
		// Even commands using direct fetch helpers must refresh after an uncertain result. Never replay them.
		if (!response.ok) await input.resolver.snapshot(true).catch(() => {})

		if (exitCode == null && (await watcherLost(response, input))) {
			input.output.writeWarn(`Watcher ${input.watcher.id} is no longer reachable; closing session.`)
			close(1)
		}
	}

	try {
		for await (const line of lines) {
			if (exitCode != null) break
			if (line.trim() === '') continue

			// Framing errors and `ping`/`quit` answer in order too, so a host matching id-less
			// responses by position stays aligned.
			const request = parseRequestLine(line)
			if (!request.ok) {
				const { response } = request
				scheduler.ordered(async () => answer(response))
				continue
			}

			const { id, cmd } = request.value
			if (cmd === 'quit') {
				scheduler.ordered(async () => {
					answer(controlResponse(id, { closed: true }))
					close(0)
				})
				continue
			}
			if (cmd === 'ping') {
				scheduler.ordered(async () => answer(controlResponse(id, { pong: true, watcher: input.watcher.id })))
				continue
			}

			if (isDialogControl(input.controlProgram, cmd)) {
				scheduler.control(run(request.value, true))
			} else {
				scheduler.ordered(run(request.value, false))
			}
		}
	} finally {
		lines.close()
	}

	// EOF still answers everything already submitted, unless the watcher is lost meanwhile.
	await Promise.race([scheduler.drain(), closed])
	return exitCode ?? 0
}

/** Whether `cmd` names a dialog control the scheduler may run beside an in-flight request. */
const isDialogControl = (controlProgram: Command, cmd: string): boolean => {
	const resolved = resolveSessionCommand(controlProgram, cmd)
	return resolved.ok && resolved.path.length === 2
}

/** Probe the watcher's dialog state; any failure reads as "no dialog", so the control just keeps waiting. */
const dialogOpen = async (id: string): Promise<boolean> => {
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) return false

	try {
		const status = await fetchWatcherJson<DialogStatusResponse>(resolved.watcher, { path: '/dialog', timeoutMs: DIALOG_PROBE_TIMEOUT_MS })
		return status.dialog != null
	} catch {
		return false
	}
}

/**
 * Decide whether the session should die with the watcher.
 *
 * Default is fail-fast: once the watcher is gone every later request would fail anyway, and
 * a host is better served by a dead session than by an endless stream of `ok: false`.
 * `--reconnect` opts out — discovery expires after 250ms and refreshes after failures, so a watcher
 * restarted under the same id is picked up without restarting the session.
 */
const watcherLost = async (response: SessionResponse, input: ServeInput): Promise<boolean> => {
	if (response.ok || input.reconnect) return false
	// A malformed request says nothing about the watcher's health.
	if (response.error.code && FRAMING_ERROR_CODES.has(response.error.code)) return false

	return !(await watcherReachable(input.watcher.id))
}

const FRAMING_ERROR_CODES = new Set(['session_invalid_request', 'session_unknown_command', 'session_command_rejected'])

/** Re-resolve by id — not by the pinned record — so a watcher that moved ports still counts as alive. */
const watcherReachable = async (id: string): Promise<boolean> => {
	const resolved = await resolveWatcher({ id })
	if (!resolved.ok) return false

	try {
		await fetchWatcherJson(resolved.watcher, { path: '/status', timeoutMs: WATCHER_PROBE_TIMEOUT_MS })
		return true
	} catch {
		return false
	}
}

type ParsedRequest = { ok: true; value: SessionRequest } | { ok: false; response: SessionResponse }

/** Framing failures are answered, never thrown: one bad line must not end a replay. */
const parseRequestLine = (line: string): ParsedRequest => {
	let decoded: unknown
	try {
		decoded = JSON.parse(line)
	} catch (error) {
		return { ok: false, response: framingError(`Request is not valid JSON: ${(error as Error).message}`) }
	}

	const parsed = SESSION_REQUEST_SCHEMA.parse(decoded)
	if (!parsed.ok) {
		const id = (decoded as { id?: SessionRequestId } | null)?.id
		return { ok: false, response: framingError(formatProtocolValidationIssues(parsed.issues), id) }
	}

	return { ok: true, value: parsed.value }
}

const framingError = (message: string, id?: SessionRequestId): SessionResponse => ({
	...idOf(id),
	ok: false,
	error: { message, code: 'session_invalid_request' },
	exitCode: 2,
	durationMs: 0,
})

/** `ping` and `quit` are answered by the session itself, without touching the command tree. */
const controlResponse = (id: SessionRequestId | undefined, result: unknown): SessionResponse => ({ ...idOf(id), ok: true, result, durationMs: 0 })

const idOf = (id: SessionRequestId | undefined): { id?: SessionRequestId } => (id === undefined ? {} : { id })

/** Build a second, session-mode command tree; the one currently mid-parse cannot re-enter itself. */
const buildSessionProgram = async (): Promise<{ program: Command; plugins: PluginLoader }> => {
	const program = createProgram({ mode: 'session' })
	for (const registerProgramPart of coreProgramRegistrars) {
		registerProgramPart(program)
	}
	const plugins = await createPluginLoader(program)
	await plugins.prepare(['session'])
	return { program, plugins }
}

/**
 * Build the dialog-control tree: only `dialog status|accept|dismiss|prompt`.
 *
 * Commander keeps parse state on the command objects, so a control dispatched while the main tree
 * is mid-parse needs a tree of its own. Controls run one at a time, so one extra tree is enough.
 */
const buildDialogControlProgram = (): Command => {
	const program = createProgram({ mode: 'session' })
	defineCommands(program, dialogCommands)
	return program
}

const readyEvent = (watcher: WatcherRecord): SessionReadyEvent => ({
	type: 'ready',
	protocolVersion: SESSION_PROTOCOL_VERSION,
	argusVersion: packageJson.version,
	watcher: { id: watcher.id, host: watcher.host, port: watcher.port },
})

const resolveDefaultTimeout = (options: RunSessionOptions, output: Output): number | null => {
	if (options.requestTimeout == null) {
		return DEFAULT_REQUEST_TIMEOUT_MS
	}

	const parsed = parseDurationMs(options.requestTimeout, 'ms')
	if (parsed == null || parsed < 0) {
		usageError({ json: output.json }, `Invalid --request-timeout: ${options.requestTimeout}`)
		return null
	}
	return parsed
}

/** `process.exit` truncates in-flight pipe writes; drain the last response first. */
const flushStdout = (): Promise<void> => new Promise((resolve) => process.stdout.write('', () => resolve()))
