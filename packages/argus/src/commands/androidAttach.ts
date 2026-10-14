import type { WatcherMatch } from '@vforsh/argus-core'
import { delay } from '@vforsh/argus-core'
import { createOutput, type Output } from '../output/io.js'
import { formatError } from '../cli/parse.js'
import {
	AdbError,
	forwardSocket,
	isValidPackageName,
	launchPackage,
	listForwards,
	readDevtoolsState,
	removeForward,
	resolveDevice,
	type DevtoolsState,
} from '../android/adb.js'
import { startForwardSupervisor, type ForwardSupervisor } from '../android/forwardSupervisor.js'
import { inspectDeviceNetwork } from '../android/network.js'
import { findWatcherOnChromePort } from '../android/portOwners.js'
import { buildWatcherMatch, registerTerminationHandlers, waitForever, type WatcherTargetingOptions } from './startShared.js'
import { startManagedWatcher } from './watcherSession.js'

export type AndroidAttachOptions = WatcherTargetingOptions & {
	package?: string
	serial?: string
	id?: string
	/** Fixed host port for the forward; adb picks a free one when omitted. */
	port?: string
	/** Start the app's launcher activity when it is not running. */
	launch?: boolean
	artifacts?: string
	pageIndicator?: boolean
	inject?: string
	json?: boolean
}

/** How long to wait for a WebView socket after launching an app: WebViews are created lazily. */
const SOCKET_WAIT_MS = 20_000
const SOCKET_POLL_MS = 500

/** Attach a watcher to an Android app's WebView through a self-maintaining adb forward. */
export const runAndroidAttach = async (options: AndroidAttachOptions): Promise<void> => {
	const output = createOutput(options)

	const packageName = options.package?.trim()
	if (!packageName || !isValidPackageName(packageName)) {
		output.writeWarn(packageName ? `Invalid --package: ${packageName}` : '--package is required (e.g. --package com.example.game)')
		process.exitCode = 2
		return
	}

	const requestedPort = parseOptionalPort(options.port)
	if (requestedPort === null) {
		output.writeWarn(`Invalid --port: ${options.port}. Must be an integer 1-65535.`)
		process.exitCode = 2
		return
	}

	try {
		await attach(packageName, requestedPort, options, output)
	} catch (error) {
		output.writeWarn(error instanceof AdbError ? error.message : `android attach failed: ${formatError(error)}`)
		process.exitCode = 1
	}
}

const attach = async (packageName: string, requestedPort: number | undefined, options: AndroidAttachOptions, output: Output): Promise<void> => {
	const resolved = await resolveDevice(options.serial?.trim() || undefined)
	if (!resolved.ok) {
		output.writeWarn(resolved.error)
		process.exitCode = 1
		return
	}
	const { serial, model } = resolved.device

	const state = await waitForSocket(serial, packageName, options.launch === true, output)
	if (!state.socket) {
		output.writeWarn(describeMissingSocket(serial, packageName, state, options.launch === true))
		process.exitCode = 1
		return
	}

	if (requestedPort != null) {
		const conflict = await describePortOwner(requestedPort)
		if (conflict) {
			output.writeWarn(`Host port ${requestedPort} is already forwarded (${conflict}). Omit --port to let adb pick a free one.`)
			process.exitCode = 1
			return
		}
	}

	// --no-rebind: never silently take over a forward another session set up on a fixed port.
	const port = await forwardSocket(serial, requestedPort ?? 0, state.socket, { noRebind: requestedPort != null })

	let supervisor: ForwardSupervisor | null = null
	const releaseForward = async (): Promise<void> => {
		if (supervisor) {
			await supervisor.stop()
			return
		}
		await removeForward(serial, port).catch(() => {})
	}

	const watcherId = options.id?.trim() || defaultWatcherId(packageName)
	const match = buildWatcherMatch(options) ?? ({ type: 'page' } satisfies WatcherMatch)
	const started = await startManagedWatcher({
		output,
		watcherId,
		idConflict: options.id?.trim() ? 'error' : 'suffix',
		source: 'cdp',
		match,
		chrome: { host: '127.0.0.1', port },
		pageIndicator: options.pageIndicator,
		artifacts: options.artifacts,
		inject: options.inject ? { file: options.inject } : undefined,
		onClose: releaseForward,
	})
	if (!started) {
		await releaseForward()
		return
	}

	const { handle, artifactsBaseDir } = started
	const log = (message: string): void => output.writeHuman(`[${handle.watcher.id}] android: ${message}`)
	supervisor = startForwardSupervisor({ serial, packageName, port, socket: state.socket, log })
	registerTerminationHandlers(async () => {
		await handle.close().catch(() => {})
	})

	const result = {
		id: handle.watcher.id,
		host: handle.watcher.host,
		port: handle.watcher.port,
		pid: handle.watcher.pid,
		android: { serial, model, package: packageName, appPid: state.pids[0] ?? null, socket: state.socket, forwardPort: port },
		match,
		artifactsBaseDir,
	}

	if (options.json) {
		output.writeJson(result)
	} else {
		output.writeHuman('Android WebView watcher started:')
		output.writeHuman(`  id=${result.id}`)
		output.writeHuman(`  device=${serial}${model ? ` (${model})` : ''}`)
		output.writeHuman(`  package=${packageName} pid=${result.android.appPid ?? '?'}`)
		output.writeHuman(`  forward=tcp:${port} → ${state.socket} (re-pointed automatically when the app restarts)`)
		output.writeHuman(`  watcher=${result.host}:${result.port}`)
		if (artifactsBaseDir) output.writeHuman(`  artifacts=${artifactsBaseDir}`)
		output.writeHuman(`Stop with \`argus watcher stop ${result.id}\`; that removes only this forward.`)
	}

	await warnAboutDeviceNetwork(serial, log)
	await waitForever()
}

/** Read the package's socket, launching the app first when asked. */
const waitForSocket = async (serial: string, packageName: string, launch: boolean, output: Output): Promise<DevtoolsState> => {
	let state = await readDevtoolsState(serial, packageName)
	if (state.socket || !launch) return state

	if (state.pids.length === 0) {
		output.writeHuman(`Launching ${packageName} on ${serial}…`)
		await launchPackage(serial, packageName)
	}

	const deadline = Date.now() + SOCKET_WAIT_MS
	while (!state.socket && Date.now() < deadline) {
		await delay(SOCKET_POLL_MS)
		state = await readDevtoolsState(serial, packageName)
	}
	return state
}

const describeMissingSocket = (serial: string, packageName: string, state: DevtoolsState, launched: boolean): string => {
	if (state.pids.length === 0) {
		return launched
			? `${packageName} did not start on ${serial} within ${SOCKET_WAIT_MS / 1000}s.`
			: `${packageName} is not running on ${serial}. Start it, or pass --launch.`
	}
	return (
		`${packageName} is running (pid ${state.pids.join(',')}) but exposes no WebView DevTools socket. ` +
		'Either its WebView is not created yet (open the screen that hosts it and retry), or WebView debugging is off: ' +
		'the app must call WebView.setWebContentsDebuggingEnabled(true). ' +
		`See every debuggable socket with \`argus android doctor --serial ${serial}\`.`
	)
}

/** Name who holds a host port: a registered watcher (with its cwd), or just the adb forward. */
const describePortOwner = async (port: number): Promise<string | null> => {
	const forward = (await listForwards()).find((candidate) => candidate.local === `tcp:${port}`)
	if (!forward) return null

	const owner = await findWatcherOnChromePort(port)
	const ownerLabel = owner ? `, used by watcher ${owner.id}${owner.cwd ? ` in ${owner.cwd}` : ''}` : ''
	return `${forward.serial} → ${forward.remote}${ownerLabel}`
}

/** Surface a broken device network path at attach time, before it shows up as a failed page load. */
const warnAboutDeviceNetwork = async (serial: string, log: (message: string) => void): Promise<void> => {
	try {
		const report = await inspectDeviceNetwork(serial)
		for (const finding of report.findings) {
			if (finding.status !== 'ok') log(`${finding.status.toUpperCase()} ${finding.message}`)
		}
	} catch (error) {
		log(`WARN could not inspect device network: ${formatError(error)}`)
	}
}

/** `com.example.tile.game` → `game`; the suffix policy takes care of repeats. */
const defaultWatcherId = (packageName: string): string => {
	const lastSegment = packageName.split('.').pop() ?? 'android'
	return lastSegment.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'android'
}

/** `undefined` when absent, `null` when invalid. */
const parseOptionalPort = (value: string | undefined): number | undefined | null => {
	if (value == null) return undefined
	const port = Number(value)
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}
