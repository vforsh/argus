import { spawn, type ChildProcess } from 'node:child_process'
import type { SessionOutputLine, SessionRequest } from '@vforsh/argus-core'

export type SessionExit = {
	code: number | null
	/** Every stdout line the session wrote, as raw text. */
	stdout: string[]
	stderr: string
}

export type SessionHarness = {
	/** Write one request line. Requests may be queued ahead of their responses. */
	send: (request: SessionRequest | Record<string, unknown> | string) => void
	/** Resolve with the next line the session writes, waiting for it if needed. */
	next: () => Promise<SessionOutputLine & Record<string, unknown>>
	/** Everything the session has written to stderr so far. */
	stderr: () => string
	/** Wait for the session to exit on its own (after `quit`, EOF, or watcher loss). */
	wait: () => Promise<SessionExit>
	/** Close stdin and wait for exit; kills the process if it outlives `timeoutMs`. */
	close: (timeoutMs?: number) => Promise<SessionExit>
}

/**
 * Drive `argus session` as a child process, one JSON line at a time.
 *
 * The exit promise is attached at spawn time on purpose: a session that dies while a test
 * is still setting up would otherwise emit `close` before anyone listened, and the test
 * would hang instead of failing.
 */
export const startSession = (binPath: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }): SessionHarness => {
	const proc: ChildProcess = spawn('bun', [binPath, 'session', ...args], { stdio: 'pipe', env: options.env, cwd: options.cwd })

	const lines: string[] = []
	const waiters: ((line: string) => void)[] = []
	let pending = ''
	let stderr = ''

	proc.stdout?.on('data', (chunk: Buffer) => {
		pending += chunk.toString()
		const parts = pending.split('\n')
		pending = parts.pop() ?? ''
		for (const part of parts) {
			if (part.trim() === '') continue
			const waiter = waiters.shift()
			if (waiter) waiter(part)
			else lines.push(part)
		}
	})
	proc.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString()
	})

	const exited: Promise<{ code: number | null }> = new Promise((resolve) => proc.on('close', (code) => resolve({ code })))
	const consumed: string[] = []

	const wait = async (): Promise<SessionExit> => {
		const { code } = await exited
		return { code, stdout: [...consumed, ...lines], stderr }
	}

	return {
		send: (request) => {
			proc.stdin?.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
		},
		next: async () => {
			const line = lines.shift() ?? (await nextLine(waiters, exited))
			consumed.push(line)
			return JSON.parse(line)
		},
		stderr: () => stderr,
		wait,
		close: async (timeoutMs = 10_000) => {
			proc.stdin?.end()
			const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
			try {
				return await wait()
			} finally {
				clearTimeout(timer)
			}
		},
	}
}

const nextLine = (waiters: ((line: string) => void)[], exited: Promise<unknown>): Promise<string> =>
	Promise.race([
		new Promise<string>((resolve) => waiters.push(resolve)),
		exited.then(() => {
			throw new Error('Session exited before writing the expected line.')
		}),
	])
