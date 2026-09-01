import { AsyncLocalStorage } from 'node:async_hooks'

/** Text a single request wrote to each stream. */
export type CapturedStdio = {
	stdout: string[]
	stderr: string[]
}

/** Handle returned by {@link installStdioCapture}. */
export type StdioCapture = {
	/**
	 * Run `body` with its stdout/stderr redirected into `sink`.
	 *
	 * The sink travels with the async context, not with wall-clock time: a command that
	 * outlives its watchdog keeps writing into its own (already abandoned) sink instead of
	 * corrupting whichever request is running by then.
	 */
	run: <T>(sink: CapturedStdio, body: () => Promise<T>) => Promise<T>
	/** Write straight to the real stdout, past the capture. Used for the JSONL responses themselves. */
	writeStdout: (text: string) => void
	/** Restore the original stream writers. */
	restore: () => void
}

type StreamWrite = typeof process.stdout.write

/**
 * Redirect every stdout write made inside a request into that request's own buffer.
 *
 * The session's contract is that stdout carries nothing but its JSONL responses, and the
 * ~200 commands it dispatches all reach stdout through their own `Output` closures — plus a
 * handful of direct `process.stdout.write` calls. Patching the stream is what makes that
 * contract hold for all of them at once, including plugin commands this file has never seen.
 *
 * stderr is captured *and* mirrored: the response carries it so a host can report a failure
 * without a second channel, and a human tailing the session's stderr still sees it live.
 */
export const installStdioCapture = (): StdioCapture => {
	const storage = new AsyncLocalStorage<CapturedStdio>()
	const originalStdoutWrite = process.stdout.write.bind(process.stdout) as StreamWrite
	const originalStderrWrite = process.stderr.write.bind(process.stderr) as StreamWrite

	process.stdout.write = createCapturingWrite(storage, originalStdoutWrite, (sink) => sink.stdout, false)
	process.stderr.write = createCapturingWrite(storage, originalStderrWrite, (sink) => sink.stderr, true)

	return {
		run: (sink, body) => storage.run(sink, body),
		writeStdout: (text) => {
			originalStdoutWrite(text)
		},
		restore: () => {
			process.stdout.write = originalStdoutWrite
			process.stderr.write = originalStderrWrite
		},
	}
}

const createCapturingWrite = (
	storage: AsyncLocalStorage<CapturedStdio>,
	original: StreamWrite,
	select: (sink: CapturedStdio) => string[],
	mirror: boolean,
): StreamWrite =>
	((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
		const sink = storage.getStore()
		if (!sink) {
			return (original as (...args: unknown[]) => boolean)(chunk, encoding, callback)
		}

		select(sink).push(decodeChunk(chunk, encoding))
		if (mirror) {
			;(original as (...args: unknown[]) => boolean)(chunk, encoding)
		}

		const done = typeof encoding === 'function' ? encoding : callback
		if (typeof done === 'function') {
			;(done as () => void)()
		}
		return true
	}) as StreamWrite

const decodeChunk = (chunk: string | Uint8Array, encoding: unknown): string => {
	if (typeof chunk === 'string') {
		return chunk
	}
	const bufferEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
	return Buffer.from(chunk).toString(bufferEncoding)
}
