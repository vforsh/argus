import fs from 'node:fs/promises'
import { isProcessAlive, parseDurationMs, type WatcherMatch } from '@vforsh/argus-core'
import type { WatcherLifecycleOptions } from '@vforsh/argus-watcher'
import { parseLabels } from '../watchers/labels.js'
import type { WatcherInjectConfig } from '../config/types.js'
import { resolvePath } from '../utils/paths.js'
import { formatError } from '../cli/parse.js'

type WarningOutput = {
	writeWarn: (message: string) => void
}

type TerminateHandler = () => Promise<void>

export type WatcherTargetingOptions = {
	url?: string
	type?: string
	origin?: string
	target?: string
	parent?: string
}

/**
 * Read an optional inject script once and keep command handlers free of file-system boilerplate.
 */
export const resolveInjectScript = async (
	inject: WatcherInjectConfig | undefined,
	output: WarningOutput,
): Promise<{ script: string; exposeArgus?: boolean } | undefined> => {
	if (!inject) {
		return undefined
	}

	const resolvedPath = resolvePath(inject.file)

	let script: string
	try {
		script = await fs.readFile(resolvedPath, 'utf8')
	} catch (error) {
		output.writeWarn(
			`Failed to read inject script at ${resolvedPath}: ${formatError(error)}. Skipping injection.`,
		)
		return undefined
	}

	if (script.trim() === '') {
		output.writeWarn(`Inject script at ${resolvedPath} is empty. Skipping injection.`)
		return undefined
	}

	return { script, exposeArgus: inject.exposeArgus }
}

/** CLI flags that bound a watcher's life and tag it (`start` and `watcher start`). */
export type WatcherLifecycleFlags = {
	ownerPid?: string
	idleExit?: string
	ttl?: string
	label?: string[]
}

/**
 * Validate lifecycle and label flags before anything is launched.
 * @returns What to pass to `startWatcher`, or null after writing a usage error (exit code 2).
 */
export const resolveWatcherLifecycle = (
	flags: WatcherLifecycleFlags,
	output: WarningOutput,
): { lifecycle?: WatcherLifecycleOptions; labels?: Record<string, string> } | null => {
	const fail = (message: string) => {
		output.writeWarn(message)
		process.exitCode = 2
		return null
	}

	const parsedLabels = parseLabels(flags.label)
	if (!parsedLabels.ok) return fail(parsedLabels.error)

	const lifecycle: WatcherLifecycleOptions = {}
	if (flags.ownerPid !== undefined) {
		const pid = Number(flags.ownerPid)
		if (!Number.isInteger(pid) || pid <= 0) return fail(`Invalid --owner-pid: ${flags.ownerPid}. Expected a positive integer.`)
		if (!isProcessAlive(pid)) return fail(`--owner-pid ${pid} is not a running process.`)
		lifecycle.ownerPid = pid
	}
	for (const [flag, key, value] of [
		['--idle-exit', 'idleExitMs', flags.idleExit],
		['--ttl', 'ttlMs', flags.ttl],
	] as const) {
		if (value === undefined) continue
		const ms = parseDurationMs(value)
		if (ms === null || ms <= 0 || !Number.isFinite(ms)) return fail(`Invalid ${flag}: ${value}. Expected a positive duration such as 30s, 10m, or 2h.`)
		lifecycle[key] = ms
	}

	return {
		lifecycle: Object.keys(lifecycle).length > 0 ? lifecycle : undefined,
		labels: Object.keys(parsedLabels.labels).length > 0 ? parsedLabels.labels : undefined,
	}
}

export const normalizeHttpUrl = (value?: string | null): string | null => {
	if (!value) {
		return null
	}
	if (value.startsWith('http://') || value.startsWith('https://')) {
		return value
	}
	return `http://${value}`
}

/**
 * Collect watcher target filters from CLI options and return `undefined` when nothing was set.
 */
export const buildWatcherMatch = (options: WatcherTargetingOptions): WatcherMatch | undefined => {
	const match: WatcherMatch = {}

	const url = options.url?.trim()
	if (url) {
		match.url = url
	}

	const type = options.type?.trim()
	if (type) {
		match.type = type
	}

	const origin = options.origin?.trim()
	if (origin) {
		match.origin = origin
	}

	const targetId = options.target?.trim()
	if (targetId) {
		match.targetId = targetId
	}

	const parent = options.parent?.trim()
	if (parent) {
		match.parent = parent
	}

	return Object.keys(match).length > 0 ? match : undefined
}

/**
 * Keep long-running commands consistent: terminate on SIGINT/SIGTERM, no per-command signal boilerplate.
 */
export const registerTerminationHandlers = (terminate: TerminateHandler): void => {
	const handleTermination = () => {
		void terminate().then(() => process.exit(0))
	}

	process.on('SIGINT', handleTermination)
	process.on('SIGTERM', handleTermination)
}

export const waitForever = async (): Promise<void> => {
	await new Promise(() => {})
}
