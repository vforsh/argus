import { spawn, ChildProcess, SpawnOptions } from 'node:child_process'

export interface CommandResult {
	stdout: string
	stderr: string
}

export async function runCommand(cmd: string, args: string[], options: SpawnOptions = {}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: 'pipe', ...options })
		let stdout = ''
		let stderr = ''
		proc.stdout?.on('data', (data) => {
			stdout += data
		})
		proc.stderr?.on('data', (data) => {
			stderr += data
		})
		proc.on('close', (code) => {
			if (code === 0) resolve({ stdout, stderr })
			else reject(new Error(`Command ${cmd} ${args.join(' ')} failed with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`))
		})
		proc.on('error', reject)
	})
}

export interface CommandResultWithExit extends CommandResult {
	code: number | null
}

export async function runCommandWithExit(cmd: string, args: string[], options: SpawnOptions = {}): Promise<CommandResultWithExit> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: 'pipe', ...options })
		let stdout = ''
		let stderr = ''
		proc.stdout?.on('data', (data) => {
			stdout += data
		})
		proc.stderr?.on('data', (data) => {
			stderr += data
		})
		proc.on('close', (code) => {
			resolve({ stdout, stderr, code })
		})
		proc.on('error', reject)
	})
}

export interface SpawnedProcess {
	proc: ChildProcess
	stdout: string
	stderr: string
}

export interface ExtendedSpawnOptions extends SpawnOptions {
	debug?: boolean
}

export async function spawnAndWait(cmd: string, args: string[], options: ExtendedSpawnOptions = {}, readyRegex: RegExp): Promise<SpawnedProcess> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: 'pipe', ...options })
		let stdout = ''
		let stderr = ''
		let resolved = false

		proc.stdout?.on('data', (data) => {
			const str = data.toString()
			stdout += str
			if (!resolved && readyRegex.test(stdout)) {
				resolved = true
				resolve({ proc, stdout, stderr })
			}
		})

		proc.stderr?.on('data', (data) => {
			const str = data.toString()
			stderr += str
		})

		proc.on('error', (err) => {
			if (!resolved) {
				resolved = true
				reject(err)
			}
		})

		proc.on('close', (code) => {
			if (!resolved) {
				resolved = true
				reject(new Error(`Process ${cmd} exited with code ${code} before matching ready regex.\nStdout: ${stdout}\nStderr: ${stderr}`))
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
