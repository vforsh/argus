import type { ArgusCommandDefinition } from '../defineCommand.js'
import { jsonOption } from './sharedOptions.js'
import { lazyAction } from '../lazyAction.js'

const runExtensionDiagnose = lazyAction(() => import('../../commands/extension/diagnose.js').then((mod) => mod.runExtensionDiagnose))
const runExtensionRecover = lazyAction(() => import('../../commands/extension/diagnose.js').then((mod) => mod.runExtensionRecover))
const runExtensionInstall = lazyAction(() => import('../../commands/extension/install.js').then((mod) => mod.runExtensionInstall))
const runExtensionSetup = lazyAction(() => import('../../commands/extension/setup.js').then((mod) => mod.runExtensionSetup))
const runExtensionPath = lazyAction(() => import('../../commands/extension/extensionPath.js').then((mod) => mod.runExtensionPath))
const runExtensionRemove = lazyAction(() => import('../../commands/extension/remove.js').then((mod) => mod.runExtensionRemove))
const runExtensionStatus = lazyAction(() => import('../../commands/extension/status.js').then((mod) => mod.runExtensionStatus))
const runExtensionInfo = lazyAction(() => import('../../commands/extension/info.js').then((mod) => mod.runExtensionInfo))
const runExtensionTabs = lazyAction(() => import('../../commands/extension/tabs.js').then((mod) => mod.runExtensionTabs))
const runExtensionAttach = lazyAction(() => import('../../commands/extension/attach.js').then((mod) => mod.runExtensionAttach))
const runExtensionDetach = lazyAction(() => import('../../commands/extension/attach.js').then((mod) => mod.runExtensionDetach))
const runExtensionShow = lazyAction(() => import('../../commands/extension/show.js').then((mod) => mod.runExtensionShow))
const runExtensionUse = lazyAction(() => import('../../commands/extension/use.js').then((mod) => mod.runExtensionUse))
const runExtensionDoctor = lazyAction(() => import('../../commands/extension/doctor.js').then((mod) => mod.runExtensionDoctor))
const runExtensionTargets = lazyAction(() => import('../../commands/extension/targets.js').then((mod) => mod.runExtensionTargets))
const runExtensionSelect = lazyAction(() => import('../../commands/extension/select.js').then((mod) => mod.runExtensionSelect))
const runExtensionMute = lazyAction(() => import('../../commands/extension/mute.js').then((mod) => mod.runExtensionMute))
const runExtensionBind = lazyAction(() => import('../../commands/extension/bind.js').then((mod) => mod.runExtensionBind))
const runExtensionBindPrepare = lazyAction(() => import('../../commands/extension/bind.js').then((mod) => mod.runExtensionBindPrepare))
const runExtensionBrowserLabel = lazyAction(() => import('../../commands/extension/browsers.js').then((mod) => mod.runExtensionBrowserLabel))
const runExtensionBrowsers = lazyAction(() => import('../../commands/extension/browsers.js').then((mod) => mod.runExtensionBrowsers))

const controlWatcherOption = {
	flags: '--id <controlWatcherId>',
	description: 'Extension control watcher (default: the only live one; required when several browsers run Argus)',
} as const

const browserOption = {
	flags: '--browser <labelOrInstanceId>',
	description: 'Pick the browser by label or instance id instead of --id (see `argus ext browsers`)',
} as const

/** `--id` or `--browser`: which browser a control command acts on. */
const controlSelectorOptions = [controlWatcherOption, browserOption] as const

const tabTargetOptions = [
	...controlSelectorOptions,
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	jsonOption,
] as const

const attachTargetOptions = [
	...controlSelectorOptions,
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	{
		flags: '--as <watcherId>',
		description: 'Start the tab watcher with a stable id (fails with watcher_id_taken if another live watcher holds it)',
	},
	{ flags: '--no-wait', description: 'Return after the extension acknowledges the attach request' },
	{ flags: '--show', description: 'After attaching, lock the tab shown+focused' },
	jsonOption,
] as const

const useTargetOptions = [
	...controlSelectorOptions,
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	{
		flags: '--as <watcherId>',
		description: 'Start the tab watcher with a stable id when attaching (fails with watcher_id_taken if another live watcher holds it)',
	},
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
	...controlSelectorOptions,
	{ flags: '--tab <tabId>', description: 'Browser tab id' },
	{ flags: '--url <substring>', description: 'Resolve tab by URL substring' },
	{ flags: '--title <substring>', description: 'Resolve tab by title substring' },
	{
		flags: '--as <watcherId>',
		description: 'Start the tab watcher with a stable id when attaching (fails with watcher_id_taken if another live watcher holds it)',
	},
	jsonOption,
] as const

export const extensionCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'extension',
		alias: 'ext',
		description: 'Browser extension management',
		subcommands: [
			...(['diagnose', 'recover'] as const).map((name) => ({
				name,
				description:
					name === 'diagnose'
						? 'Save a private incident bundle before reload (works offline)'
						: 'Save evidence, attempt selected tab recovery and verify each layer',
				options: [
					{ flags: '--out <directory>', description: 'New local bundle directory (required; never overwritten)' },
					{ flags: '--watcher <watcherId>', description: 'Inspect and verify this extension target' },
					{ flags: '--platform', description: 'Opt in to bounded process CPU/RSS metadata (no argv or environment)' },
					...(name === 'recover' ? [{ flags: '--tab <tabId>', description: 'Attempt supported attach for this Chrome tab' }] : []),
					jsonOption,
				],
				action: async (options: Parameters<typeof runExtensionDiagnose>[0]) => {
					await (name === 'diagnose' ? runExtensionDiagnose : runExtensionRecover)(options)
				},
			})),
			{
				name: 'install',
				description: 'Set up the extension end-to-end: install hosts, open chrome://extensions, wait for connect',
				options: [
					{ flags: '--no-open', description: 'Do not open chrome://extensions automatically' },
					{ flags: '--no-wait', description: 'Do not wait for the extension to connect' },
					{ flags: '--timeout <seconds>', description: 'Seconds to wait for the extension to connect (default 120)' },
					jsonOption,
				],
				examples: ['argus extension install', 'argus extension install --no-open', 'argus extension install --no-wait --json'],
				action: async (options) => {
					await runExtensionInstall(options)
				},
			},
			{
				name: 'setup [extensionId]',
				description: 'Install native messaging host (uses the pinned extension ID by default)',
				options: [jsonOption],
				configure: (command) => {
					command.addHelpText(
						'after',
						'\nThe Argus extension pins a stable ID, so no argument is needed.\nPrefer `argus extension install` for the guided, end-to-end flow.\nPass an explicit id only when loading a differently-keyed build.\n',
					)
				},
				action: async (extensionId, options) => {
					await runExtensionSetup({ extensionId, ...options })
				},
			},
			{
				name: 'path',
				description: 'Print the path to the unpacked extension for chrome://extensions "Load unpacked"',
				options: [jsonOption],
				examples: ['argus extension path', 'argus extension path --json'],
				action: async (options) => {
					await runExtensionPath(options)
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
				options: [
					{ flags: '--id <controlWatcherId>', description: 'Extension control watcher (inferred from --watcher when possible)' },
					browserOption,
					{ flags: '--watcher <watcherId>', description: 'Include diagnostics for one extension-backed watcher' },
					jsonOption,
				],
				examples: ['argus ext doctor', 'argus ext doctor --watcher vk-game', 'argus ext doctor --id extension-control-2 --json'],
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
					...controlSelectorOptions,
					{ flags: '--url <substring>', description: 'Filter tabs by URL substring' },
					{ flags: '--title <substring>', description: 'Filter tabs by title substring' },
					jsonOption,
				],
				examples: [
					'argus ext tabs',
					'argus ext tabs --url localhost',
					'argus ext tabs --title Docs --json',
					'argus ext tabs --id extension-control-2',
				],
				action: async (options) => {
					await runExtensionTabs(options)
				},
			},
			{
				name: 'bind',
				description: "Bind exactly the tab that opened a ticket's bindUrl: attach (or reuse), open the destination, wait ready",
				arguments: [{ flags: '<ticket>', description: 'Ticket from `argus ext bind prepare`' }],
				options: [
					{
						flags: '--as <watcherId>',
						description: 'Tab watcher id (fails with watcher_id_taken if another live watcher holds it)',
					},
					{ flags: '--label <label>', description: 'Label the bound browser instance (e.g. codex) for later --browser selection' },
					{
						flags: '--visibility <policy>',
						description: 'Hold the tab shown: foreground (may raise its window) or background (never activates it)',
					},
					jsonOption,
				],
				examples: [
					'argus ext bind prepare --to https://web.max.ru/ --json',
					'argus ext bind argus-bind-… --as max --label codex --visibility background --json',
				],
				subcommands: [
					{
						name: 'prepare',
						description: 'Create a one-time ticket (~60s) and the waiting-page URL to open in the tab to bind',
						options: [{ flags: '--to <url>', description: 'Destination URL the bound tab is navigated to', required: true }, jsonOption],
						examples: ['argus ext bind prepare --to https://web.max.ru/ --json'],
						action: async (options) => {
							await runExtensionBindPrepare(options)
						},
					},
				],
				action: async (ticket, options) => {
					await runExtensionBind(ticket, options)
				},
			},
			{
				name: 'browsers',
				description: 'List browser instances running the extension (instance id, label, control, versions)',
				options: [jsonOption],
				examples: ['argus ext browsers', 'argus ext browsers --json', 'argus ext browsers label <instanceId> codex'],
				subcommands: [
					{
						name: 'label',
						description: 'Label a live browser instance for --browser selection',
						arguments: [
							{ flags: '<instanceId>', description: 'Instance id from `argus ext browsers`' },
							{ flags: '<label>', description: 'Label, e.g. codex or chrome' },
						],
						options: [jsonOption],
						action: async (instanceId, label, options) => {
							await runExtensionBrowserLabel(instanceId, label, options)
						},
					},
				],
				action: async (options) => {
					await runExtensionBrowsers(options)
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
					...controlSelectorOptions,
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
			{
				name: 'mute',
				description: 'Mute an extension-controlled browser tab',
				arguments: [{ flags: '[id]', description: 'Attached extension watcher id' }],
				options: tabTargetOptions,
				examples: ['argus ext mute app', 'argus ext mute --tab 123', 'argus ext mute --url localhost', 'argus ext mute --title Docs --json'],
				action: async (id, options) => {
					await runExtensionMute(id, options, true)
				},
			},
			{
				name: 'unmute',
				description: 'Unmute an extension-controlled browser tab',
				arguments: [{ flags: '[id]', description: 'Attached extension watcher id' }],
				options: tabTargetOptions,
				examples: [
					'argus ext unmute app',
					'argus ext unmute --tab 123',
					'argus ext unmute --url localhost',
					'argus ext unmute --title Docs --json',
				],
				action: async (id, options) => {
					await runExtensionMute(id, options, false)
				},
			},
		],
	},
]
