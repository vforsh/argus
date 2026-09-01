import readline from 'node:readline'
import type { Command } from 'commander'
import type { SessionReadyEvent, SessionRequest, SessionResponse, WatcherRecord } from '@vforsh/argus-core'
import { SESSION_PROTOCOL_VERSION, SESSION_REQUEST_SCHEMA, formatProtocolValidationIssues, parseDurationMs } from '@vforsh/argus-core'
import packageJson from '../../package.json' with { type: 'json' }
import { createProgram } from '../cli/program.js'
import { coreProgramRegistrars } from '../cli/register/index.js'
import { registerPlugins } from '../cli/plugins/registerPlugins.js'
import { usageError } from '../cli/validation.js'
import { createOutput, routeConsoleToStderr, type Output } from '../output/io.js'
import { fetchWatcherJson, resolveWatcherOrExit } from '../watchers/requestWatcher.js'
import { resolveWatcher } from '../watchers/resolveWatcher.js'
import { dispatchSessionRequest } from './sessionDispatch.js'
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

	const program = await buildSessionProgram()
	const capture = installStdioCapture()
	const writeLine = (line: SessionReadyEvent | SessionResponse): void => capture.writeStdout(`${JSON.stringify(line)}\n`)

	writeLine(readyEvent(resolved.watcher))

	const exitCode = await serveRequests({ program, capture, writeLine, watcher: resolved.watcher, defaultTimeoutMs, options, output })

	capture.restore()
	await flushStdout()
	// A command abandoned by its watchdog can still hold a socket open; exit rather than
	// wait for an event loop the session no longer controls.
	process.exit(exitCode)
}

type ServeInput = {
	program: Command
	capture: ReturnType<typeof installStdioCapture>
	writeLine: (line: SessionResponse) => void
	watcher: WatcherRecord
	defaultTimeoutMs: number
	options: RunSessionOptions
	output: Output
}

/**
 * Read one request per line until stdin ends or a `quit` arrives.
 *
 * Requests run strictly in submission order. Pipelining is still worth it — the host can
 * keep writing while a command is in flight — but ordering keeps `process.exitCode`, which
 * is how ~200 commands report failure, meaningful for exactly one request at a time.
 */
const serveRequests = async (input: ServeInput): Promise<number> => {
	const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

	try {
		for await (const line of lines) {
			if (line.trim() === '') continue

			const request = parseRequestLine(line)
			if (!request.ok) {
				input.writeLine(request.response)
				continue
			}

			if (request.value.cmd === 'quit') {
				input.writeLine({ ...idOf(request.value), ok: true, result: { closed: true }, durationMs: 0 })
				return 0
			}
			if (request.value.cmd === 'ping') {
				input.writeLine({ ...idOf(request.value), ok: true, result: { pong: true, watcher: input.watcher.id }, durationMs: 0 })
				continue
			}

			const response = await dispatchSessionRequest({
				program: input.program,
				capture: input.capture,
				request: request.value,
				watcherId: input.watcher.id,
				defaultTimeoutMs: input.defaultTimeoutMs,
			})
			input.writeLine(response)

			if (await watcherLost(response, input)) {
				input.output.writeWarn(`Watcher ${input.watcher.id} is no longer reachable; closing session.`)
				return 1
			}
		}
	} finally {
		lines.close()
	}

	return 0
}

/**
 * Decide whether the session should die with the watcher.
 *
 * Default is fail-fast: once the watcher is gone every later request would fail anyway, and
 * a host is better served by a dead session than by an endless stream of `ok: false`.
 * `--reconnect` opts out — each request re-resolves the id through the registry, so a watcher
 * restarted under the same id is picked up without restarting the session.
 */
const watcherLost = async (response: SessionResponse, input: ServeInput): Promise<boolean> => {
	if (response.ok || input.options.reconnect) return false
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
		const id = (decoded as { id?: string | number } | null)?.id
		return { ok: false, response: framingError(formatProtocolValidationIssues(parsed.issues), id) }
	}

	return { ok: true, value: parsed.value }
}

const framingError = (message: string, id?: string | number): SessionResponse => ({
	...(id === undefined ? {} : { id }),
	ok: false,
	error: { message, code: 'session_invalid_request' },
	exitCode: 2,
	durationMs: 0,
})

const idOf = (request: SessionRequest): { id?: string | number } => (request.id === undefined ? {} : { id: request.id })

/** Build a second, session-mode command tree; the one currently mid-parse cannot re-enter itself. */
const buildSessionProgram = async (): Promise<Command> => {
	const program = createProgram({ mode: 'session' })
	for (const registerProgramPart of coreProgramRegistrars) {
		registerProgramPart(program)
	}
	await registerPlugins(program)
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
