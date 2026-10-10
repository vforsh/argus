import { CommanderError, type Command } from 'commander'
import type { ErrorDetail, SessionRequest, SessionResponse } from '@vforsh/argus-core'
import { formatError, isArgusErrorCode, parseDurationMs } from '@vforsh/argus-core'
import { runWithExitCodeScope, type ExitCodeScope } from '../output/exitCode.js'
import { withRequestContext, type RequestScope } from './requestContext.js'
import { buildSessionArgv } from './sessionArgv.js'
import type { CapturedStdio, StdioCapture } from './stdioCapture.js'

export type SessionDispatchInput = {
	program: Command
	/** Load plugin command metadata before resolving args and aliases. */
	prepare?: () => Promise<void>
	capture: StdioCapture
	request: SessionRequest
	/** Watcher the session is pinned to. */
	watcherId: string
	/** Watchdog applied when the request does not carry its own `timeout`. `0` disables it. */
	defaultTimeoutMs: number
	/**
	 * Whether this request may reset and read `process.exitCode`. Only the session's serial lane
	 * may: a dialog control runs beside it and relies on {@link runWithExitCodeScope} alone.
	 */
	ownsProcessExitCode: boolean
}

/**
 * Run one request through the real command tree and turn it into a response line.
 *
 * The command is the same object graph `argus <cmd>` would run — same validation, same
 * `--json` payload, same exit-code conventions — so a host that already parses one-shot
 * output does not have to parse anything new.
 */
export const dispatchSessionRequest = async (input: SessionDispatchInput): Promise<SessionResponse> => {
	const { request } = input
	const respond = createResponder(request, Date.now())

	const timeoutMs = resolveTimeoutMs(request.timeout, input.defaultTimeoutMs)
	if (timeoutMs == null) {
		return respond.failure({ message: `Invalid timeout "${String(request.timeout)}".`, code: 'session_invalid_request' }, 2)
	}

	const sink: CapturedStdio = { stdout: [], stderr: [] }
	const scope: ExitCodeScope = {}
	const controller = new AbortController()
	const requestScope: RequestScope = { signal: controller.signal, deadline: timeoutMs > 0 ? Date.now() + timeoutMs : undefined }
	if (input.ownsProcessExitCode) process.exitCode = 0

	const running = input.capture.run(sink, () =>
		withRequestContext(requestScope, () =>
			runWithExitCodeScope(scope, async () => {
				try {
					await input.prepare?.()
					const built = buildSessionArgv({ program: input.program, request, watcherId: input.watcherId })
					if (!built.ok) {
						return new CommanderError(2, built.code, built.message)
					}
					await input.program.parseAsync(built.argv, { from: 'user' })
					return null
				} catch (error) {
					return error
				}
			}),
		),
	)

	const settled = await raceWithTimeout(running, timeoutMs)
	const stderr = sink.stderr.join('')

	if (settled.timedOut) {
		controller.abort()
		// The abandoned command keeps its own sink through {@link installStdioCapture}, so
		// whatever it writes later cannot land in the next request's output.
		return respond.failure(
			{
				message: `Request timed out after ${timeoutMs}ms.${requestScope.mutation ? ' Mutation acknowledgement was lost; inspect state before retrying.' : ''}`,
				code: 'session_request_timeout',
				...(requestScope.mutation ? { mutation: { ...requestScope.mutation, outcome: 'uncertain' as const } } : {}),
			},
			1,
			stderr,
		)
	}

	const exitCode = takeExitCode(scope, input.ownsProcessExitCode)
	const stdout = sink.stdout.join('')

	if (settled.error) {
		return fromThrownError(respond, settled.error, stdout, stderr)
	}
	if (exitCode !== 0) {
		return respond.failure(errorDetailFrom(stdout, stderr), exitCode, stderr)
	}

	return respond.success(stdout, stderr)
}

/**
 * Read how the command reported failure; an untouched code means success.
 *
 * Shared plumbing reports into the request's scope; commands that still assign `process.exitCode`
 * directly are only trusted on the lane that owns the global.
 */
const takeExitCode = (scope: ExitCodeScope, ownsProcessExitCode: boolean): number => {
	if (!ownsProcessExitCode) return scope.exitCode ?? 0

	const assigned = typeof process.exitCode === 'number' ? process.exitCode : 0
	process.exitCode = 0
	return scope.exitCode ?? assigned
}

/** `--help` and `--version` reach us as a zero-exit Commander throw; both are legitimate answers. */
const fromThrownError = (respond: Responder, error: unknown, stdout: string, stderr: string): SessionResponse => {
	if (!(error instanceof CommanderError)) {
		return respond.failure({ message: formatError(error), code: 'session_command_failed' }, 1, stderr)
	}
	if (error.exitCode === 0) {
		return respond.success(stdout, stderr)
	}
	const code = error.code.startsWith('session_') && isArgusErrorCode(error.code) ? error.code : 'session_invalid_request'
	return respond.failure({ message: error.message, code }, error.exitCode || 2, stderr)
}

/**
 * Decode what the command wrote to stdout.
 *
 * One JSON document decodes to itself, several decode to an array (`stream: true`), and
 * anything that is not JSON is handed back verbatim (`raw: true`) rather than guessed at.
 */
const decodeStdout = (stdout: string): { result: unknown; stream?: true; raw?: true } => {
	const lines = stdout.split('\n').filter((line) => line.trim() !== '')
	if (lines.length === 0) {
		return { result: null }
	}

	const documents: unknown[] = []
	for (const line of lines) {
		try {
			documents.push(JSON.parse(line))
		} catch {
			return { result: stdout, raw: true }
		}
	}

	return documents.length === 1 ? { result: documents[0] } : { result: documents, stream: true }
}

/**
 * Recover the machine-readable failure a command already produced.
 *
 * A watcher-side failure arrives as the standard `ok: false` envelope on stdout; a local
 * failure (bad flag combination, unresolvable watcher) only wrote prose to stderr.
 */
const errorDetailFrom = (stdout: string, stderr: string): ErrorDetail => {
	const document = decodeStdout(stdout).result
	if (document && typeof document === 'object' && (document as { ok?: unknown }).ok === false) {
		const detail = (document as { error?: ErrorDetail }).error
		if (detail?.message) {
			return detail
		}
	}

	const message = stderr.trim().split('\n').filter(Boolean).at(-1)
	return { message: message ?? 'Command failed.', code: 'session_command_failed' }
}

type Responder = {
	success: (stdout: string, stderr: string) => SessionResponse
	failure: (error: ErrorDetail, exitCode: number, stderr?: string) => SessionResponse
}

/**
 * Bind the fields both response arms share — the correlation id and the elapsed time — so the
 * seven exit paths above only name what actually differs between them.
 */
const createResponder = (request: SessionRequest, startedAt: number): Responder => {
	const id = request.id === undefined ? {} : { id: request.id }
	const trailer = (stderr: string) => ({ durationMs: Date.now() - startedAt, ...(stderr === '' ? {} : { stderr }) })

	return {
		success: (stdout, stderr) => ({ ...id, ok: true, ...decodeStdout(stdout), ...trailer(stderr) }),
		failure: (error, exitCode, stderr = '') => ({ ...id, ok: false, error, exitCode, ...trailer(stderr) }),
	}
}

const resolveTimeoutMs = (timeout: SessionRequest['timeout'], fallbackMs: number): number | null => {
	if (timeout == null) {
		return fallbackMs
	}
	if (typeof timeout === 'number') {
		return timeout
	}
	return parseDurationMs(timeout, 'ms')
}

type Settled = { timedOut: true } | { timedOut: false; error: unknown }

const raceWithTimeout = async (running: Promise<unknown>, timeoutMs: number): Promise<Settled> => {
	if (timeoutMs <= 0) {
		return { timedOut: false, error: await running }
	}

	let timer: NodeJS.Timeout | undefined
	const watchdog = new Promise<Settled>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
	})

	try {
		return await Promise.race([running.then((error): Settled => ({ timedOut: false, error })), watchdog])
	} finally {
		clearTimeout(timer)
	}
}
