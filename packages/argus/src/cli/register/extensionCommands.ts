import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runExtensionSetup } from '../../commands/extension/setup.js'
import { runExtensionRemove } from '../../commands/extension/remove.js'
import { runExtensionStatus } from '../../commands/extension/status.js'
import { runExtensionInfo } from '../../commands/extension/info.js'
import { runExtensionTabs } from '../../commands/extension/tabs.js'
import { runExtensionAttach, runExtensionDetach } from '../../commands/extension/attach.js'
import { runExtensionShow } from '../../commands/extension/show.js'

const jsonOption = { flags: '--json', description: 'Output JSON for automation' } as const

const tabTargetOptions = [
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	jsonOption,
] as const

export const extensionCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'extension',
		alias: 'ext',
		description: 'Browser extension management',
		subcommands: [
			{
				name: 'setup <extensionId>',
				description: 'Install native messaging host for the browser extension',
				options: [jsonOption],
				configure: (command) => {
					command.addHelpText(
						'after',
						'\nTo get your extension ID:\n  1. Open chrome://extensions\n  2. Enable Developer mode\n  3. Load argus-extension as unpacked\n  4. Copy the ID from the extension card\n',
					)
				},
				action: async (extensionId, options) => {
					await runExtensionSetup({ extensionId, ...options })
				},
			},
			{
				name: 'remove',
				description: 'Uninstall native messaging host',
				options: [jsonOption],
				action: async (options) => {
					await runExtensionRemove(options)
				},
			},
			{
				name: 'status',
				description: 'Check native messaging host configuration',
				options: [jsonOption],
				action: async (options) => {
					await runExtensionStatus(options)
				},
			},
			{
				name: 'info',
				description: 'Show native messaging host paths and configuration',
				options: [jsonOption],
				action: async (options) => {
					await runExtensionInfo(options)
				},
			},
			{
				name: 'tabs',
				description: 'List browser tabs visible to the extension transport',
				options: [
					{ flags: '--id <watcherId>', description: 'Extension-backed watcher id to use as the transport (default: extension-control)' },
					{ flags: '--url <substring>', description: 'Filter tabs by URL substring' },
					{ flags: '--title <substring>', description: 'Filter tabs by title substring' },
					jsonOption,
				],
				examples: [
					'argus ext tabs',
					'argus ext tabs --url localhost',
					'argus ext tabs --title Docs --json',
					'argus ext tabs --id extension-2',
				],
				action: async (options) => {
					await runExtensionTabs(options)
				},
			},
			{
				name: 'attach',
				description: 'Ask the extension control watcher to attach a browser tab',
				options: tabTargetOptions,
				examples: ['argus ext attach --tab 123', 'argus ext attach --url localhost', 'argus ext attach --title Docs --json'],
				action: async (options) => {
					await runExtensionAttach(options)
				},
			},
			{
				name: 'detach',
				description: 'Ask the extension control watcher to detach a browser tab',
				options: tabTargetOptions,
				examples: ['argus ext detach --tab 123', 'argus ext detach --url localhost', 'argus ext detach --title Docs --json'],
				action: async (options) => {
					await runExtensionDetach(options)
				},
			},
			{
				name: 'show',
				description: 'Attach or resolve an extension tab and lock it shown+focused',
				arguments: [{ flags: '[id]', description: 'Attached extension watcher id' }],
				options: tabTargetOptions,
				configure: (command) => {
					command.addHelpText(
						'after',
						'\nExamples:\n  $ argus ext show extension\n  $ argus ext show --tab 123\n  $ argus ext show --url localhost\n  $ argus ext show --title "Cocos Creator" --json\n\nWith --tab/--url/--title, attaches the tab first if needed, then applies the\nsame sticky shown+focused lock as `argus page show <watcherId>`.\n',
					)
				},
				action: async (id, options) => {
					await runExtensionShow(id, options)
				},
			},
		],
	},
]
