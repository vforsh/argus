import { spawn, ChildProcess, SpawnOptions } from 'node:child_process'

export interface CommandOptions extends SpawnOptions {
	input?: string
}

export interface CommandResult {
	stdout: string
	stderr: string
}

export async function runCommand(cmd: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const { proc, output } = spawnWithOutput(cmd, args, options)
		proc.on('close', (code) => {
			if (code === 0) resolve(output)
			else reject(new Error(formatCommandFailure(cmd, args, code, output)))
		})
		proc.on('error', reject)
	})
}

export interface CommandResultWithExit extends CommandResult {
	code: number | null
}

export async function runCommandWithExit(cmd: string, args: string[], options: CommandOptions = {}): Promise<CommandResultWithExit> {
	return new Promise((resolve, reject) => {
		const { proc, output } = spawnWithOutput(cmd, args, options)
		proc.on('close', (code) => {
			resolve({ ...output, code })
		})
		proc.on('error', reject)
	})
}

export interface SpawnedProcess {
	proc: ChildProcess
	stdout: string
	stderr: string
}

export interface ExtendedSpawnOptions extends CommandOptions {
	debug?: boolean
}

export async function spawnAndWait(cmd: string, args: string[], options: ExtendedSpawnOptions = {}, readyRegex: RegExp): Promise<SpawnedProcess> {
	return new Promise((resolve, reject) => {
		const { proc, output } = spawnWithOutput(cmd, args, options)
		let resolved = false
		const tryResolve = () => {
			if (!resolved && readyRegex.test(output.stdout)) {
				resolved = true
				resolve({ proc, ...output })
			}
		}

		proc.stdout?.on('data', () => {
			tryResolve()
		})

		// Some commands print their ready line immediately, before we attach the
		// waiter-specific listener above. Check the buffered output once up-front
		// so fast-starting processes don't race the readiness detector.
		tryResolve()

		proc.on('error', (err) => {
			if (!resolved) {
				resolved = true
				reject(err)
			}
		})

		proc.on('close', (code) => {
			if (!resolved) {
				resolved = true
				reject(
					new Error(
						`Process ${cmd} exited with code ${code} before matching ready regex.\nStdout: ${output.stdout}\nStderr: ${output.stderr}`,
					),
				)
			}
		})
	})
}

export interface StopProcessOptions {
	signal?: NodeJS.Signals | number
	timeoutMs?: number
	forceSignal?: NodeJS.Signals | number
	forceTimeoutMs?: number
}

/**
 * Stop a spawned process and wait for it to exit.
 *
 * Test teardowns that only send SIGTERM can race with later cleanup when the
 * machine is busy, so we wait for a clean exit and escalate if needed.
 */
export async function stopProcess(proc: ChildProcess | undefined, options: StopProcessOptions = {}): Promise<void> {
	if (!proc || proc.exitCode !== null) {
		return
	}

	const { signal = 'SIGTERM', timeoutMs = 1_000, forceSignal = 'SIGKILL', forceTimeoutMs = 1_000 } = options

	await new Promise<void>((resolve, reject) => {
		let settled = false
		let forceTimer: NodeJS.Timeout | undefined
		let failTimer: NodeJS.Timeout | undefined

		const cleanup = () => {
			if (forceTimer) clearTimeout(forceTimer)
			if (failTimer) clearTimeout(failTimer)
			proc.off('close', onClose)
			proc.off('error', onError)
		}

		const settle = (callback: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			callback()
		}

		const onClose = () => settle(resolve)
		const onError = (error: Error) => settle(() => reject(error))

		proc.once('close', onClose)
		proc.once('error', onError)

		try {
			proc.kill(signal)
		} catch (error) {
			onError(error as Error)
			return
		}

		forceTimer = setTimeout(() => {
			if (proc.exitCode !== null) {
				return
			}

			try {
				proc.kill(forceSignal)
			} catch (error) {
				onError(error as Error)
				return
			}

			failTimer = setTimeout(() => {
				settle(() => reject(new Error(`Process ${proc.pid ?? 'unknown'} did not exit after ${timeoutMs + forceTimeoutMs}ms`)))
			}, forceTimeoutMs)
		}, timeoutMs)
	})
}

type BufferedOutput = {
	stdout: string
	stderr: string
}

const spawnWithOutput = (cmd: string, args: string[], options: CommandOptions): { proc: ChildProcess; output: BufferedOutput } => {
	const { input, ...spawnOptions } = options
	const proc = spawn(cmd, args, { stdio: 'pipe', ...spawnOptions })
	const output: BufferedOutput = { stdout: '', stderr: '' }

	proc.stdout?.on('data', (data) => {
		output.stdout += data.toString()
	})
	proc.stderr?.on('data', (data) => {
		output.stderr += data.toString()
	})

	if (input !== undefined) {
		proc.stdin?.end(input)
	}

	return { proc, output }
}

const formatCommandFailure = (cmd: string, args: string[], code: number | null, output: BufferedOutput): string =>
	`Command ${cmd} ${args.join(' ')} failed with code ${code}\nStdout: ${output.stdout}\nStderr: ${output.stderr}`
