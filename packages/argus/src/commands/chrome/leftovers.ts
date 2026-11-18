import { execFile } from 'node:child_process'
import { realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { delay, type WatcherRecord } from '@vforsh/argus-core'
import { loadActiveRegistry } from '../../registry.js'
import { createOutput } from '../../output/io.js'
import { formatAge } from '../../output/format.js'
import { formatLabels } from '../../watchers/labels.js'

/** Every profile Argus launches Chrome with is a `mkdtemp(os.tmpdir()/argus-chrome-*)` directory. */
const ARGUS_PROFILE_PREFIX = 'argus-chrome-'
const CHROME_EXECUTABLE = /chrom(e|ium)/i

/** A browser process on an Argus temp profile whose launcher is gone. */
export type OrphanChrome = {
	pid: number
	userDataDir: string
	/** Process start time as `ps` prints it; with the pid, this identifies the process across scans. */
	startedAt: string
}

type ProcessRow = { pid: number; ppid: number; startedAt: string; args: string }

/**
 * Find Chrome browser processes on an Argus temp profile whose parent process is gone.
 *
 * `argus start` and `argus chrome start` keep Chrome as a direct child, so a live launcher means a
 * live parent. A launcher killed with SIGKILL leaves Chrome reparented to init/launchd (ppid 1).
 * Only browsers Argus could have launched qualify: a Chrome executable, a CDP port flag, and a
 * profile named `argus-chrome-*` directly under the temp dir. Helpers (`--type=…`) exit with their browser.
 * Linux subreapers adopt orphans under their own pid, so those orphans are not detected.
 */
export const findOrphanChromes = async (): Promise<OrphanChrome[]> => {
	const rows = await listProcesses()
	const pids = new Set(rows.map((row) => row.pid))
	return rows.flatMap((row) => {
		const orphan = toArgusChrome(row)
		if (!orphan || (row.ppid !== 1 && pids.has(row.ppid))) return []
		return [orphan]
	})
}

const toArgusChrome = (row: ProcessRow): OrphanChrome | null => {
	if (/\s--type=/.test(row.args) || !/\s--remote-debugging-port=/.test(row.args)) return null
	const executable = row.args.split(' --')[0]
	if (!CHROME_EXECUTABLE.test(path.basename(executable))) return null
	const userDataDir = row.args.match(/\s--user-data-dir=(\S+)/)?.[1]
	if (!userDataDir || !isArgusTempProfile(userDataDir)) return null
	return { pid: row.pid, userDataDir, startedAt: row.startedAt }
}

const tempRoots = (): Set<string> => {
	const roots = new Set([path.resolve(tmpdir())])
	try {
		roots.add(realpathSync(tmpdir()))
	} catch {}
	return roots
}

const isArgusTempProfile = (dir: string): boolean =>
	path.basename(dir).startsWith(ARGUS_PROFILE_PREFIX) && tempRoots().has(path.dirname(path.resolve(dir)))

const listProcesses = async (): Promise<ProcessRow[]> => {
	if (process.platform === 'win32') return []
	let stdout: string
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,args='], { timeout: 5_000, maxBuffer: 32 * 1024 * 1024 }, (error, out) =>
				error ? reject(error) : resolve(out),
			)
		})
	} catch {
		return []
	}
	// lstart is always five fields: `Wed Nov 18 10:00:00 2026`.
	return stdout.split('\n').flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/)
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3], args: match[4] }] : []
	})
}

/** The subset of `orphans` that are still the very same processes (pid not reused since the scan). */
const stillRunning = async (orphans: OrphanChrome[]): Promise<OrphanChrome[]> => {
	const current = new Map((await listProcesses()).map((row) => [row.pid, toArgusChrome(row)]))
	return orphans.filter((orphan) => {
		const now = current.get(orphan.pid)
		return now != null && now.startedAt === orphan.startedAt && now.userDataDir === orphan.userDataDir
	})
}

/**
 * Terminate orphans (SIGTERM, then SIGKILL) and remove their temp profiles.
 * Identity is re-checked before each signal, so a pid reused in the meantime is never signalled.
 * @returns Pids that are gone afterwards.
 */
export const killOrphanChromes = async (orphans: OrphanChrome[]): Promise<number[]> => {
	for (const orphan of await stillRunning(orphans)) signal(orphan.pid, 'SIGTERM')
	const deadline = Date.now() + 3_000
	while (Date.now() < deadline && (await stillRunning(orphans)).length > 0) await delay(200)
	for (const orphan of await stillRunning(orphans)) signal(orphan.pid, 'SIGKILL')
	await delay(200)

	const survivors = new Set((await stillRunning(orphans)).map((orphan) => orphan.pid))
	const killed = orphans.filter((orphan) => !survivors.has(orphan.pid))
	for (const orphan of killed) rmSync(orphan.userDataDir, { recursive: true, force: true })
	return killed.map((orphan) => orphan.pid)
}

const signal = (pid: number, name: NodeJS.Signals): void => {
	try {
		process.kill(pid, name)
	} catch {}
}

/** What is still running from earlier sessions, plus the commands that clean it up. */
export type LeftoverReport = {
	watchers: WatcherRecord[]
	orphanChromes: OrphanChrome[]
}

export const collectLeftovers = async (): Promise<LeftoverReport> => {
	const [registry, orphanChromes] = await Promise.all([loadActiveRegistry().catch(() => null), findOrphanChromes()])
	return { watchers: registry ? Object.values(registry.watchers) : [], orphanChromes }
}

/** Human lines describing leftovers and how to remove them; empty when nothing is left over. */
export const formatLeftovers = (report: LeftoverReport, now = Date.now()): string[] => {
	const lines: string[] = []
	if (report.watchers.length > 0) {
		lines.push(`Live watchers (${report.watchers.length}):`)
		for (const watcher of report.watchers) {
			const parts = [`  ${watcher.id}`, `age ${formatAge(now - watcher.startedAt)}`, `pid ${watcher.pid}`]
			if (watcher.cwd) parts.push(`cwd ${watcher.cwd}`)
			const labels = formatLabels(watcher.labels)
			if (labels) parts.push(`labels ${labels}`)
			if (watcher.lifecycle?.ownerPid) parts.push(`owner-pid ${watcher.lifecycle.ownerPid}`)
			lines.push(parts.join('  '))
		}
	}
	if (report.orphanChromes.length > 0) {
		lines.push(`Orphaned Chrome processes on Argus temp profiles (${report.orphanChromes.length}, no watcher owns them):`)
		for (const orphan of report.orphanChromes) lines.push(`  pid ${orphan.pid}  started ${orphan.startedAt}  ${orphan.userDataDir}`)
	}
	if (lines.length === 0) return lines

	lines.push('Clean up:')
	for (const watcher of report.watchers) lines.push(`  argus watcher stop ${watcher.id}`)
	if (report.orphanChromes.length > 0) lines.push('  argus chrome prune-orphans')
	lines.push('To keep this from recurring, start watchers with --owner-pid, --idle-exit or --ttl.')
	return lines
}

export type ChromePruneOrphansOptions = { dryRun?: boolean; json?: boolean }

/** `argus chrome prune-orphans`: kill Chrome processes left on Argus temp profiles by crashed launchers. */
export const runChromePruneOrphans = async (options: ChromePruneOrphansOptions): Promise<void> => {
	const output = createOutput(options)
	const orphans = await findOrphanChromes()
	if (options.dryRun || orphans.length === 0) {
		if (options.json) output.writeJson({ orphans, killed: [], dryRun: options.dryRun === true })
		else if (orphans.length === 0) output.writeHuman('No orphaned Argus Chrome processes.')
		else for (const orphan of orphans) output.writeHuman(`would kill pid ${orphan.pid} (${orphan.userDataDir}, started ${orphan.startedAt})`)
		return
	}

	const killed = await killOrphanChromes(orphans)
	const survivors = orphans.filter((orphan) => !killed.includes(orphan.pid))
	if (survivors.length > 0) process.exitCode = 1
	if (options.json) {
		output.writeJson({ orphans, killed, dryRun: false })
		return
	}
	for (const pid of killed) output.writeHuman(`killed pid ${pid}`)
	for (const orphan of survivors) output.writeWarn(`failed to kill pid ${orphan.pid}`)
}
