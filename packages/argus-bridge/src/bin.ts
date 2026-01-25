#!/usr/bin/env node
/**
 * CLI entry point for argus-bridge.
 *
 * Usage:
 *   argus-bridge start [options]    Start the bridge (Native Messaging host mode)
 *   argus-bridge install-host       Install Native Messaging host manifest
 */

import { startBridge } from './index.js'
import { installNativeHost, uninstallNativeHost } from './scripts/install-host.js'

const args = process.argv.slice(2)
const command = args[0]

const printUsage = (): void => {
	console.log(`
argus-bridge - Native Messaging host for Argus Chrome extension

Usage:
  argus-bridge start [options]     Start the bridge
  argus-bridge install-host        Install Native Messaging host manifest
  argus-bridge uninstall-host      Remove Native Messaging host manifest

Start options:
  --id <id>         Bridge identifier (default: "bridge")
  --host <host>     HTTP server host (default: "127.0.0.1")
  --port <port>     HTTP server port (default: 0 for ephemeral)
  --standalone      Run without Native Messaging (for manual testing)

Examples:
  argus-bridge start --id my-bridge --port 9333
  argus-bridge install-host
`)
}

const parseArgs = (args: string[]): Record<string, string> => {
	const result: Record<string, string> = {}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg.startsWith('--')) {
			const key = arg.slice(2)
			const value = args[i + 1]
			if (value && !value.startsWith('--')) {
				result[key] = value
				i++
			} else {
				result[key] = 'true'
			}
		}
	}
	return result
}

const main = async (): Promise<void> => {
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		printUsage()
		process.exit(0)
	}

	if (command === 'start') {
		const options = parseArgs(args.slice(1))
		const id = options.id ?? 'bridge'
		const host = options.host ?? '127.0.0.1'
		const port = options.port ? parseInt(options.port, 10) : 0
		const standalone = options.standalone === 'true'

		try {
			const handle = await startBridge({ id, host, port, standalone })

			// Handle graceful shutdown
			const shutdown = async (): Promise<void> => {
				console.error('\n[Bridge] Received shutdown signal')
				await handle.close()
				process.exit(0)
			}

			process.on('SIGINT', shutdown)
			process.on('SIGTERM', shutdown)

			// Keep the process running
			// The Native Messaging protocol on stdin will keep it alive
		} catch (error) {
			console.error('[Bridge] Failed to start:', error)
			process.exit(1)
		}
		return
	}

	if (command === 'install-host') {
		try {
			const extensionId = args[1] // Optional: specific extension ID
			await installNativeHost(extensionId)
			console.log('Native Messaging host installed successfully')
			process.exit(0)
		} catch (error) {
			console.error('Failed to install Native Messaging host:', error)
			process.exit(1)
		}
		return
	}

	if (command === 'uninstall-host') {
		try {
			await uninstallNativeHost()
			console.log('Native Messaging host uninstalled successfully')
			process.exit(0)
		} catch (error) {
			console.error('Failed to uninstall Native Messaging host:', error)
			process.exit(1)
		}
		return
	}

	console.error(`Unknown command: ${command}`)
	printUsage()
	process.exit(1)
}

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
