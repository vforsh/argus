import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runExtensionSetup } from '../../commands/extension/setup.js'
import { runExtensionRemove } from '../../commands/extension/remove.js'
import { runExtensionStatus } from '../../commands/extension/status.js'
import { runExtensionInfo } from '../../commands/extension/info.js'
import { runExtensionTabs } from '../../commands/extension/tabs.js'
import { runExtensionAttach, runExtensionDetach } from '../../commands/extension/attach.js'
import { runExtensionShow } from '../../commands/extension/show.js'
import { runExtensionUse } from '../../commands/extension/use.js'
import { runExtensionDoctor } from '../../commands/extension/doctor.js'
import { runExtensionTargets } from '../../commands/extension/targets.js'
import { runExtensionSelect } from '../../commands/extension/select.js'

const jsonOption = { flags: '--json', description: 'Output JSON for automation' } as const

const tabTargetOptions = [
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	jsonOption,
] as const

const attachTargetOptions = [
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	{ flags: '--as <watcherId>', description: 'Start the tab watcher with a stable id' },
	{ flags: '--no-wait', description: 'Return after the extension acknowledges the attach request' },
	{ flags: '--show', description: 'After attaching, lock the tab shown+focused' },
	jsonOption,
] as const

const useTargetOptions = [
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	{ flags: '--as <watcherId>', description: 'Start the tab watcher with a stable id when attaching' },
	{ flags: '--iframe <mode>', description: 'Select an iframe after attaching (currently: auto)' },
	{ flags: '--iframe-url <substring>', description: 'Select iframe by URL substring after attaching' },
	{ flags: '--iframe-title <substring>', description: 'Select iframe by title substring after attaching' },
	{ flags: '--show', description: 'Lock the resolved watcher shown+focused' },
	jsonOption,
] as const

const iframeTargetOptions = [
	{ flags: '--page', description: 'Select the top page target' },
	{ flags: '--iframe <mode>', description: 'Select an iframe target (currently: auto)' },
	{ flags: '--iframe-url <substring>', description: 'Select iframe by URL substring' },
	{ flags: '--iframe-title <substring>', description: 'Select iframe by title substring' },
] as const

const showTargetOptions = [
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	{ flags: '--as <watcherId>', description: 'Start the tab watcher with a stable id when attaching' },
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
				name: 'doctor',
				description: 'Diagnose native host and live extension-control state',
				options: [{ flags: '--watcher <watcherId>', description: 'Include diagnostics for one extension-backed watcher' }, jsonOption],
				examples: ['argus ext doctor', 'argus ext doctor --watcher vk-game', 'argus ext doctor --json'],
				action: async (options) => {
					await runExtensionDoctor(options)
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
				description: 'Attach a browser tab through the extension control watcher',
				options: attachTargetOptions,
				examples: [
					'argus ext attach --tab 123',
					'argus ext attach --url localhost --as app',
					'argus ext attach --url localhost --show',
					'argus ext attach --title Docs --no-wait --json',
				],
				action: async (options) => {
					await runExtensionAttach(options)
				},
			},
			{
				name: 'use',
				description: 'Resolve or attach an extension tab and print its watcher id',
				options: useTargetOptions,
				examples: [
					'argus ext use --url localhost --as app',
					'argus ext use --url vk.com/app --as vk-game --iframe-url stark.games',
					'argus ext use --url vk.com/app --as vk-game --iframe auto',
					'argus ext use --title Docs --show',
					'argus ext use --tab 123 --json',
				],
				action: async (options) => {
					await runExtensionUse(options)
				},
			},
			{
				name: 'targets',
				description: 'List page and iframe targets for an extension tab watcher',
				arguments: [{ flags: '[id]', description: 'Attached extension watcher id' }],
				options: [
					{ flags: '--tab <tabId>', description: 'Browser tab id' },
					{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
					{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
					{ flags: '--as <watcherId>', description: 'Stable id to use if the tab must be attached first' },
					{ flags: '--type <type>', description: 'Filter targets by type, e.g. page or iframe' },
					{ flags: '--tree', description: 'Print targets as a parent/child tree' },
					jsonOption,
				],
				examples: [
					'argus ext targets vk-game --tree',
					'argus ext targets --url vk.com/app --as vk-game',
					'argus ext targets --tab 123 --type iframe --json',
				],
				action: async (id, options) => {
					await runExtensionTargets(id, options)
				},
			},
			{
				name: 'select',
				description: 'Select the page or an iframe target inside an extension tab watcher',
				arguments: [{ flags: '[id]', description: 'Attached extension watcher id' }],
				options: [
					...iframeTargetOptions,
					{ flags: '--no-wait', description: 'Return after the extension acknowledges the target switch' },
					jsonOption,
				],
				examples: [
					'argus ext select vk-game --iframe-url stark.games',
					'argus ext select vk-game --iframe-title "Ёлочка 2025"',
					'argus ext select vk-game --iframe auto',
					'argus ext select vk-game --page',
				],
				action: async (id, options) => {
					await runExtensionSelect(id, options)
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
				options: showTargetOptions,
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
