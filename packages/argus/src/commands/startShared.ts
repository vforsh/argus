import fs from 'node:fs/promises'
import type { WatcherMatch } from '@vforsh/argus-core'
import type { WatcherInjectConfig } from '../config/argusConfig.js'
import { resolvePath } from '../utils/paths.js'

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
			`Failed to read inject script at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}. Skipping injection.`,
		)
		return undefined
	}

	if (script.trim() === '') {
		output.writeWarn(`Inject script at ${resolvedPath} is empty. Skipping injection.`)
		return undefined
	}

	return { script, exposeArgus: inject.exposeArgus }
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
