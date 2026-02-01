import type { Command } from 'commander'
import { runExtensionSetup } from '../../commands/extension/setup.js'
import { runExtensionRemove } from '../../commands/extension/remove.js'
import { runExtensionStatus } from '../../commands/extension/status.js'
import { runExtensionInfo } from '../../commands/extension/info.js'

export function registerExtension(program: Command): void {
	const extension = program.command('extension').alias('ext').description('Browser extension management')

	extension
		.command('setup <extensionId>')
		.description('Install native messaging host for the browser extension')
		.option('--json', 'Output JSON for automation')
		.addHelpText(
			'after',
			'\nTo get your extension ID:\n  1. Open chrome://extensions\n  2. Enable Developer mode\n  3. Load argus-extension as unpacked\n  4. Copy the ID from the extension card\n',
		)
		.action(async (extensionId, options) => {
			await runExtensionSetup({ extensionId, ...options })
		})

	extension
		.command('remove')
		.description('Uninstall native messaging host')
		.option('--json', 'Output JSON for automation')
		.action(async (options) => {
			await runExtensionRemove(options)
		})

	extension
		.command('status')
		.description('Check native messaging host configuration')
		.option('--json', 'Output JSON for automation')
		.action(async (options) => {
			await runExtensionStatus(options)
		})

	extension
		.command('info')
		.description('Show native messaging host paths and configuration')
		.option('--json', 'Output JSON for automation')
		.action(async (options) => {
			await runExtensionInfo(options)
		})
}
