import { spawn } from 'node:child_process'
import { readRegistry } from '@vforsh/argus-core'
import { createOutput, type Output } from '../../output/io.js'
import { pruneRegistry } from '../../registry.js'
import { resolveChromeBin } from '../../utils/chromeBin.js'
import { ARGUS_EXTENSION_ID } from './extensionId.js'
import { resolveExtensionDir } from './extensionPath.js'
import { CONTROL_WATCHER_ID, findArgusExecutable, installNativeHosts, type InstalledNativeHost } from './nativeHost.js'
import { emitFailure, getPlatformOrFail } from './failures.js'

export type ExtensionInstallOptions = {
	/** Open chrome://extensions automatically. Disable with --no-open. */
	open?: boolean
	/** Wait for the extension to connect. Disable with --no-wait. */
	wait?: boolean
	/** Seconds to wait for the extension to connect (default 120). */
	timeout?: string
	json?: boolean
}

const DEFAULT_TIMEOUT_SECONDS = 120
const POLL_INTERVAL_MS = 700

/**
 * One-command extension setup: install the native messaging hosts with the
 * pinned ID, open chrome://extensions, point the user at the unpacked folder,
 * then wait until the extension connects and report the first command to run.
 */
export const runExtensionInstall = async (options: ExtensionInstallOptions): Promise<void> => {
	const output = createOutput(options)

	const platform = getPlatformOrFail(output)
	if (!platform) return

	const extensionDir = resolveExtensionDir()
	if (!extensionDir) {
		return emitFailure(output, {
			error: 'Packaged Argus extension not found. Build the CLI (npm run build:packages) or run from a built checkout.',
		})
	}

	let executablePath: string
	try {
		executablePath = findArgusExecutable()
	} catch (error) {
		return emitFailure(output, { error: (error as Error).message })
	}

	let hosts: InstalledNativeHost[]
	try {
		hosts = installNativeHosts(platform, ARGUS_EXTENSION_ID, executablePath)
	} catch (error) {
		return emitFailure(output, { error: `Failed to install native hosts: ${(error as Error).message}` })
	}

	await pruneRegistry()
	let connected = await isControlConnected()

	const shouldOpen = options.open !== false && !connected
	const opened = shouldOpen ? openExtensionsPage() : false

	if (!output.json) {
		printSummary(output, { extensionDir, hosts, connected, opened, shouldOpen })
	}

	const shouldWait = options.wait !== false && !connected
	if (shouldWait) {
		connected = await waitForControl(parseTimeoutMs(options.timeout), output)
	}

	if (output.json) {
		output.writeJson({ ok: true, extensionId: ARGUS_EXTENSION_ID, extensionPath: extensionDir, hosts, connected })
		if (!connected && shouldWait) {
			process.exitCode = 1
		}
		return
	}

	printResult(output, connected, shouldWait)
}

const isControlConnected = async (): Promise<boolean> => {
	const { registry } = await readRegistry()
	return Boolean(registry.watchers[CONTROL_WATCHER_ID])
}

const openExtensionsPage = (): boolean => {
	const chromeBin = resolveChromeBin()
	if (!chromeBin) {
		return false
	}
	try {
		const child = spawn(chromeBin, ['chrome://extensions/'], { stdio: 'ignore', detached: true })
		child.unref()
		return true
	} catch {
		return false
	}
}

const waitForControl = async (timeoutMs: number, output: Output): Promise<boolean> => {
	if (!output.json) {
		output.writeHuman(`Waiting for the extension to connect (up to ${Math.round(timeoutMs / 1000)}s)...`)
	}
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await isControlConnected()) {
			return true
		}
		await delay(POLL_INTERVAL_MS)
	}
	return isControlConnected()
}

const printSummary = (
	output: Output,
	info: { extensionDir: string; hosts: InstalledNativeHost[]; connected: boolean; opened: boolean; shouldOpen: boolean },
): void => {
	output.writeHuman('')
	output.writeHuman('Argus extension setup')
	output.writeHuman('')
	output.writeHuman(`  Native hosts:  installed (${info.hosts.map((host) => host.hostName).join(', ')})`)
	output.writeHuman(`  Extension ID:  ${ARGUS_EXTENSION_ID}`)
	output.writeHuman(`  Load unpacked: ${info.extensionDir}`)
	output.writeHuman('')

	if (info.connected) {
		return
	}

	if (info.opened) {
		output.writeHuman('Opened chrome://extensions. Click "Load unpacked" and select the folder above.')
	} else if (info.shouldOpen) {
		output.writeHuman('Open chrome://extensions, then click "Load unpacked" and select the folder above.')
	} else {
		output.writeHuman('Open chrome://extensions and "Load unpacked" the folder above.')
	}
	output.writeHuman('(Enable Developer mode if the "Load unpacked" button is hidden.)')
	output.writeHuman('')
}

const printResult = (output: Output, connected: boolean, waited: boolean): void => {
	if (connected) {
		output.writeHuman('Extension connected.')
		output.writeHuman('')
		output.writeHuman('Try it:')
		output.writeHuman('  argus ext tabs')
		output.writeHuman('')
		return
	}

	if (waited) {
		output.writeHuman('Extension did not connect yet.')
		output.writeHuman('  - If it is already loaded, open its popup or reload it in chrome://extensions.')
		output.writeHuman('  - Then check `argus extension status` and `argus ext doctor`.')
		output.writeHuman('')
		process.exitCode = 1
		return
	}

	output.writeHuman('Once loaded, verify with `argus ext tabs`.')
	output.writeHuman('')
}

const parseTimeoutMs = (value: string | undefined): number => {
	const seconds = value ? Number.parseInt(value, 10) : DEFAULT_TIMEOUT_SECONDS
	if (!Number.isFinite(seconds) || seconds < 5) {
		return DEFAULT_TIMEOUT_SECONDS * 1000
	}
	return seconds * 1000
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
