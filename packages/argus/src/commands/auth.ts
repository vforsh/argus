import { parseAuthStateSnapshot, type AuthStateLoadResponse, type AuthStateSnapshot, type WatcherRecord } from '@vforsh/argus-core'
import { readFile, writeFile } from 'node:fs/promises'
import { normalizeUrl } from './chrome/shared.js'
import type { Output } from '../output/io.js'
import { createOutput } from '../output/io.js'
import type { WatcherRequestSuccess } from '../watchers/requestWatcher.js'
import { requestWatcherAction, requestWatcherJson, writeRequestError } from '../watchers/requestWatcher.js'

export type AuthExportStateOptions = {
	domain?: string
	out?: string
}

export type AuthLoadStateOptions = {
	inputPath: string
	url?: string
	json?: boolean
}

export type AuthCloneOptions = {
	targetId: string
	url?: string
	json?: boolean
}

type AuthOutput = ReturnType<typeof createOutput>
type AuthStateSnapshotResult = WatcherRequestSuccess<AuthStateSnapshot>
type AuthStateLoadResult = { watcher: WatcherRecord; data: AuthStateLoadResponse }

/** Execute `argus auth export-state`. */
export const runAuthExportState = async (id: string | undefined, options: AuthExportStateOptions): Promise<void> => {
	const output = createOutput({})
	const result = await requestAuthStateSnapshot(id, { domain: options.domain }, output)
	if (!result) {
		return
	}

	await writeOutput(JSON.stringify(result.data, null, 2), options.out)
}

/** Execute `argus auth load-state`. */
export const runAuthLoadState = async (id: string | undefined, options: AuthLoadStateOptions): Promise<void> => {
	const output = createOutput(options)
	const snapshot = await readAuthStateSnapshotOrExit(options.inputPath, output)
	if (!snapshot) {
		return
	}
	const result = await loadAuthStateIntoWatcher(id, snapshot, { url: options.url }, output)
	if (!result) {
		return
	}

	if (options.json) {
		output.writeJson(result.data)
		return
	}

	output.writeHuman(formatLoadStateMessage(result.watcher.id, result.data.startupUrl))
}

/** Execute `argus auth clone`. */
export const runAuthClone = async (sourceId: string | undefined, options: AuthCloneOptions): Promise<void> => {
	const output = createOutput(options)
	const source = await requestAuthStateSnapshot(sourceId, {}, output)
	if (!source) {
		return
	}

	const target = await loadAuthStateIntoWatcher(options.targetId, source.data, { url: options.url }, output)
	if (!target) {
		return
	}

	if (options.json) {
		output.writeJson({
			ok: true,
			from: source.watcher.id,
			to: target.watcher.id,
			startupUrl: target.data.startupUrl,
		})
		return
	}

	output.writeHuman(formatCloneStateMessage(source.watcher.id, target.watcher.id, target.data.startupUrl))
}

export const loadAuthStateSnapshot = async (inputPath: string): Promise<AuthStateSnapshot> => {
	const source = inputPath === '-' ? 'stdin' : `file ${inputPath}`
	const raw = await readAuthStateInput(inputPath)
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new Error(`Invalid auth state from ${source}: ${error instanceof Error ? error.message : String(error)}`)
	}

	return parseAuthStateSnapshot(parsed, `auth state ${source}`)
}

/**
 * Request an auth-state snapshot from a watcher and preserve watcher-resolution errors.
 * Shared by export, clone, and start --auth-from flows so they all use the same transport path.
 */
export const requestAuthStateSnapshot = async (
	id: string | undefined,
	input: { domain?: string },
	output: AuthOutput,
): Promise<AuthStateSnapshotResult | null> => {
	const result = await requestWatcherJson<AuthStateSnapshot>({
		id,
		path: '/auth/state',
		query: buildStateQuery(input),
		timeoutMs: 10_000,
	})

	if (!result.ok) {
		writeRequestError(result, output)
		return null
	}

	return result
}

/** Load an auth-state snapshot into a target watcher. */
export const loadAuthStateIntoWatcher = async (
	id: string | undefined,
	snapshot: AuthStateSnapshot,
	input: { url?: string },
	output: AuthOutput,
): Promise<AuthStateLoadResult | null> => {
	const result = await requestWatcherAction<AuthStateLoadResponse>(
		{
			id,
			path: '/auth/state/load',
			method: 'POST',
			body: {
				snapshot,
				url: input.url ? normalizeUrl(input.url) : undefined,
			},
			timeoutMs: 15_000,
		},
		output,
	)

	if (!result) {
		return null
	}

	return result
}

const readAuthStateSnapshotOrExit = async (inputPath: string, output: Output): Promise<AuthStateSnapshot | null> => {
	try {
		return await loadAuthStateSnapshot(inputPath)
	} catch (error) {
		output.writeWarn(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
		return null
	}
}

const readAuthStateInput = async (inputPath: string): Promise<string> => {
	if (inputPath !== '-') {
		return readFile(inputPath, 'utf8')
	}

	if (process.stdin.isTTY) {
		throw new Error('Cannot read auth state from stdin when stdin is a TTY. Pipe data or use --in <path>.')
	}

	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

const formatLoadStateMessage = (watcherId: string, startupUrl: string | null): string => {
	if (startupUrl) {
		return `loaded auth state into ${watcherId} and navigated to ${startupUrl}`
	}

	return `loaded auth state into ${watcherId}`
}

const formatCloneStateMessage = (sourceId: string, targetId: string, startupUrl: string | null): string => {
	if (startupUrl) {
		return `cloned auth state from ${sourceId} to ${targetId} and navigated to ${startupUrl}`
	}

	return `cloned auth state from ${sourceId} to ${targetId}`
}

const buildStateQuery = (input: { domain?: string }): URLSearchParams => {
	const params = new URLSearchParams()
	if (input.domain?.trim()) {
		params.set('domain', input.domain.trim())
	}
	return params
}

const writeOutput = async (content: string, outPath?: string): Promise<void> => {
	const withTrailingNewline = content.endsWith('\n') ? content : `${content}\n`
	if (outPath && outPath !== '-') {
		await writeFile(outPath, withTrailingNewline, 'utf8')
		return
	}
	process.stdout.write(withTrailingNewline)
}
