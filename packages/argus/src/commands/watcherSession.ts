import type { WatcherMatch } from '@vforsh/argus-core'
import { startWatcher, type PageConsoleLogging, type WatcherHandle, type WatcherSourceMode } from '@vforsh/argus-watcher'
import type { Output } from '../output/io.js'
import type { WatcherInjectConfig } from '../config/argusConfig.js'
import { resolvePath } from '../utils/paths.js'
import { resolveInjectScript } from './startShared.js'

export type StartManagedWatcherOptions = {
	output: Output
	watcherId: string
	source: WatcherSourceMode
	match?: WatcherMatch
	chrome?: { host: string; port: number }
	pageIndicator?: boolean
	artifacts?: string
	pageConsoleLogging?: PageConsoleLogging
	inject?: WatcherInjectConfig
}

export type ManagedWatcherStartResult = {
	handle: WatcherHandle
	artifactsBaseDir?: string
}

/**
 * Start a watcher with the shared CLI defaults and lifecycle logging.
 * Keeps long-running commands focused on their source-specific setup.
 */
export const startManagedWatcher = async (options: StartManagedWatcherOptions): Promise<ManagedWatcherStartResult | null> => {
	const { output } = options
	const artifactsResolution = resolveArtifactsBaseDir(options.artifacts, output)
	if (!artifactsResolution.ok) {
		return null
	}
	const artifactsBaseDir = artifactsResolution.value

	const inject = await resolveInjectScript(options.inject, output)

	let handle: WatcherHandle
	try {
		handle = await startWatcher({
			id: options.watcherId,
			source: options.source,
			match: options.match,
			chrome: options.chrome,
			host: '127.0.0.1',
			port: 0,
			net: { enabled: true },
			pageIndicator: options.pageIndicator === false ? { enabled: false } : { enabled: true },
			artifacts: artifactsBaseDir ? { base: artifactsBaseDir } : undefined,
			pageConsoleLogging: options.pageConsoleLogging,
			inject: inject ?? undefined,
		})
	} catch (error) {
		output.writeWarn(`Failed to start watcher: ${error instanceof Error ? error.message : error}`)
		process.exitCode = 1
		return null
	}

	registerWatcherEventLogging(handle, output)

	return {
		handle,
		artifactsBaseDir,
	}
}

export const registerWatcherEventLogging = (handle: WatcherHandle, output: Output): void => {
	handle.events.on('cdpAttached', ({ target }) => {
		const typeInfo = target?.type ? ` (type: ${target.type})` : ''
		output.writeHuman(`[${handle.watcher.id}] CDP attached: ${target?.title} (${target?.url})${typeInfo}`)
	})

	handle.events.on('cdpDetached', ({ reason, target }) => {
		output.writeHuman(`[${handle.watcher.id}] CDP detached: ${reason} (last target: ${target?.title})`)
	})
}

const resolveArtifactsBaseDir = (artifacts: string | undefined, output: Output): { ok: true; value: string | undefined } | { ok: false } => {
	if (artifacts == null) {
		return { ok: true, value: undefined }
	}

	const trimmed = artifacts.trim()
	if (trimmed === '') {
		output.writeWarn('--artifacts must be a non-empty path when provided.')
		process.exitCode = 2
		return { ok: false }
	}

	return { ok: true, value: resolvePath(trimmed) }
}
