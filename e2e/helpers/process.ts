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

export async function runCommandWithExit(
	cmd: string,
	args: string[],
	options: SpawnOptions = {},
): Promise<CommandResultWithExit> {
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
