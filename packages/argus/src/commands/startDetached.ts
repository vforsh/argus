import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getLogsDir } from '@vforsh/argus-core'
import type { StartResult } from './start.js'

type ReadyMessage = { type: 'argus_start_ready'; result: StartResult }

/** Spawn this CLI with independent stdio and wait for its startup handshake; failures terminate only that child. */
export const startDetached = async (): Promise<StartResult> => {
	const logsDir = getLogsDir()
	mkdirSync(logsDir, { recursive: true })
	const launcherLog = path.join(mkdtempSync(path.join(logsDir, 'start-')), 'launcher.log')
	const logFd = openSync(launcherLog, 'a', 0o600)
	let child: ChildProcess
	try {
		const argv = process.argv.slice(1)
		if (!argv.includes('--json')) argv.push('--json')
		child = spawn(process.execPath, [...process.execArgv, ...argv], {
			detached: true,
			stdio: ['ignore', 'ignore', logFd, 'ipc'],
		})
	} finally {
		closeSync(logFd)
	}

	try {
		const result = await waitForReady(child, launcherLog)
		child.unref()
		return { ...result, launcherLog }
	} catch (error) {
		await stopStartingChild(child)
		throw error
	}
}

const waitForReady = (child: ChildProcess, launcherLog: string): Promise<StartResult> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Detached start timed out. See ${launcherLog}`)), 60_000)
		const cleanup = () => {
			clearTimeout(timer)
			child.off('message', onMessage)
			child.off('error', onError)
			child.off('exit', onExit)
		}
		const finish = (error?: Error, result?: StartResult) => {
			cleanup()
			if (error) reject(error)
			else resolve(result!)
		}
		const onMessage = (message: unknown) => {
			const ready = message as ReadyMessage | null
			if (ready?.type === 'argus_start_ready') finish(undefined, ready.result)
		}
		const onError = (error: Error) => finish(error)
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const details = readFileSync(launcherLog, 'utf8').trim().slice(-4_000)
			finish(new Error(`Detached start exited (${signal ?? code}) before becoming ready. ${details}\nSee ${launcherLog}`))
		}
		child.on('message', onMessage)
		child.once('error', onError)
		child.once('exit', onExit)
	})

const stopStartingChild = async (child: ChildProcess): Promise<void> => {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
		}, 10_000)
		child.once('exit', () => {
			clearTimeout(timer)
			resolve()
		})
		child.kill('SIGTERM')
	})
}

/** Announce successful startup over IPC and release the parent connection without retaining its stdio. */
export const announceDetachedStart = async (result: StartResult): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		process.send!({ type: 'argus_start_ready', result } satisfies ReadyMessage, (error: Error | null) => {
			if (error) reject(error)
			else resolve()
		})
	})
	process.disconnect?.()
}
