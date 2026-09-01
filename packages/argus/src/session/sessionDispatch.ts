import { CommanderError, type Command } from 'commander'
import type { ErrorDetail, SessionRequest, SessionResponse } from '@vforsh/argus-core'
import { formatError, parseDurationMs } from '@vforsh/argus-core'
import { buildSessionArgv } from './sessionArgv.js'
import type { CapturedStdio, StdioCapture } from './stdioCapture.js'

export type SessionDispatchInput = {
	program: Command
	capture: StdioCapture
	request: SessionRequest
	/** Watcher the session is pinned to. */
	watcherId: string
	/** Watchdog applied when the request does not carry its own `timeout`. `0` disables it. */
	defaultTimeoutMs: number
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
	const startedAt = Date.now()

	const timeoutMs = resolveTimeoutMs(request.timeout, input.defaultTimeoutMs)
	if (timeoutMs == null) {
		return failure(request, startedAt, { message: `Invalid timeout "${String(request.timeout)}".`, code: 'session_invalid_request' }, 2)
	}

	const built = buildSessionArgv({ program: input.program, request, watcherId: input.watcherId })
	if (!built.ok) {
		return failure(request, startedAt, { message: built.message, code: built.code }, 2)
	}

	const sink: CapturedStdio = { stdout: [], stderr: [] }
	process.exitCode = 0

	const running = input.capture.run(sink, async () => {
		try {
			await input.program.parseAsync(built.argv, { from: 'user' })
			return null
		} catch (error) {
			return error
		}
	})

	const settled = await raceWithTimeout(running, timeoutMs)
	const stderr = sink.stderr.join('')

	if (settled.timedOut) {
		// The abandoned command keeps its own sink through {@link installStdioCapture}, so
		// whatever it writes later cannot land in the next request's output.
		return failure(request, startedAt, { message: `Request timed out after ${timeoutMs}ms.`, code: 'session_request_timeout' }, 1, stderr)
	}

	const exitCode = normalizeExitCode(process.exitCode)
	process.exitCode = 0
	const stdout = sink.stdout.join('')

	if (settled.error) {
		return fromThrownError(request, startedAt, settled.error, stdout, stderr)
	}
	if (exitCode !== 0) {
		return failure(request, startedAt, errorDetailFrom(stdout, stderr), exitCode, stderr)
	}

	return success(request, startedAt, stdout, stderr)
}

/** `--help` and `--version` reach us as a zero-exit Commander throw; both are legitimate answers. */
const fromThrownError = (request: SessionRequest, startedAt: number, error: unknown, stdout: string, stderr: string): SessionResponse => {
	if (error instanceof CommanderError) {
		if (error.exitCode === 0) {
			return success(request, startedAt, stdout, stderr)
		}
		return failure(request, startedAt, { message: error.message, code: 'session_invalid_request' }, error.exitCode || 2, stderr)
	}
	return failure(request, startedAt, { message: formatError(error), code: 'session_command_failed' }, 1, stderr)
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

/** Leading fields every response carries, in the order a host reads them. */
const head = (request: SessionRequest): { id?: string | number } => (request.id === undefined ? {} : { id: request.id })

/** Trailing fields every response carries, whichever arm it lands in. */
const tail = (startedAt: number, stderr: string): { durationMs: number; stderr?: string } => ({
	durationMs: Date.now() - startedAt,
	...(stderr === '' ? {} : { stderr }),
})

const success = (request: SessionRequest, startedAt: number, stdout: string, stderr: string): SessionResponse => ({
	...head(request),
	ok: true,
	...decodeStdout(stdout),
	...tail(startedAt, stderr),
})

const failure = (request: SessionRequest, startedAt: number, error: ErrorDetail, exitCode: number, stderr = ''): SessionResponse => ({
	...head(request),
	ok: false,
	error,
	exitCode,
	...tail(startedAt, stderr),
})

/** Commands report failure through `process.exitCode`; an untouched code means success. */
const normalizeExitCode = (value: number | string | undefined | null): number => (typeof value === 'number' ? value : 0)

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
		if (timer) clearTimeout(timer)
	}
}
