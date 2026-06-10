import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runChromeTargets, runChromeOpen, runChromeActivate, runChromeClose } from '../../commands/chrome.js'
import { runPageReload } from '../../commands/page.js'
import { runPageEmulationSet, runPageEmulationClear, runPageEmulationStatus } from '../../commands/pageEmulation.js'
import { runPageShow, runPageHide } from '../../commands/pageVisibility.js'
import { listPresetNames } from '../../emulation/devices.js'
import { collectParam } from '../validation.js'

const cdpTargetOptions = [
	{ flags: '--cdp <host:port>', description: 'CDP host:port' },
	{ flags: '--id <watcherId>', description: 'Use chrome config from a registered watcher' },
	{ flags: '--json', description: 'Output JSON for automation' },
] as const

const presetList = listPresetNames().join(', ')

const emulationCommand: ArgusCommandDefinition = {
	name: 'emulation',
	alias: 'emu',
	description: 'Device emulation controls (viewport, touch, user-agent)',
	subcommands: [
		{
			name: 'set',
			description: 'Set device emulation on the watcher-attached page',
			arguments: [{ flags: '[id]', description: 'Watcher ID' }],
			options: [
				{ flags: '--device <name>', description: `Device preset (${presetList})` },
				{ flags: '--width <n>', description: 'Viewport width (px)' },
				{ flags: '--height <n>', description: 'Viewport height (px)' },
				{ flags: '--dpr <n>', description: 'Device pixel ratio' },
				{ flags: '--mobile', description: 'Enable mobile emulation' },
				{ flags: '--no-mobile', description: 'Disable mobile emulation' },
				{ flags: '--touch', description: 'Enable touch emulation' },
				{ flags: '--no-touch', description: 'Disable touch emulation' },
				{ flags: '--ua <string>', description: 'Override user-agent string' },
				{ flags: '--json', description: 'Output JSON for automation' },
			],
			configure: (command) => {
				command.addHelpText(
					'after',
					`\nExamples:\n  $ argus page emulation set app --device iphone-14\n  $ argus page emulation set app --width 1600 --height 900\n  $ argus page emulation set app --device pixel-7 --width 500\n  $ argus page emu set app --device desktop-1440\n\nAvailable devices: ${presetList}\n`,
				)
			},
			action: async (id, options) => {
				await runPageEmulationSet(id, options)
			},
		},
		{
			name: 'clear',
			description: 'Clear device emulation (restore defaults)',
			arguments: [{ flags: '[id]', description: 'Watcher ID' }],
			options: [{ flags: '--json', description: 'Output JSON for automation' }],
			examples: ['argus page emulation clear app', 'argus page emu clear app --json'],
			action: async (id, options) => {
				await runPageEmulationClear(id, options)
			},
		},
		{
			name: 'status',
			description: 'Show current emulation state',
			arguments: [{ flags: '[id]', description: 'Watcher ID' }],
			options: [{ flags: '--json', description: 'Output JSON for automation' }],
			examples: ['argus page emulation status app', 'argus page emu status app --json'],
			action: async (id, options) => {
				await runPageEmulationStatus(id, options)
			},
		},
	],
}

export const pageCommands: readonly ArgusCommandDefinition[] = [
	{
		name: 'page',
		alias: 'tab',
		description: 'Page/tab management commands',
		subcommands: [
			{
				name: 'ls',
				aliases: ['targets', 'list'],
				description: 'List Chrome targets (tabs, extensions, etc.)',
				options: [
					{ flags: '--type <type>', description: 'Filter by target type (e.g. page, worker, iframe)' },
					{ flags: '--tree', description: 'Show targets as a tree with parent-child relationships' },
					...cdpTargetOptions,
				],
				examples: [
					'argus page ls',
					'argus page ls --type page',
					'argus page ls --type iframe',
					'argus page ls --tree',
					'argus page ls --json',
					'argus page ls --id app',
				],
				action: async (options) => {
					await runChromeTargets(options)
				},
			},
			{
				name: 'open',
				alias: 'new',
				description: 'Open a new tab in Chrome',
				options: [{ flags: '--url <url>', description: 'URL to open', required: true }, ...cdpTargetOptions],
				examples: [
					'argus page open --url http://localhost:3000',
					'argus page open --url localhost:3000',
					'argus page open --url http://example.com --json',
				],
				action: async (options) => {
					await runChromeOpen(options)
				},
			},
			{
				name: 'activate',
				description: 'Activate (focus) a Chrome target',
				arguments: [{ flags: '[targetId]', description: 'Target ID to activate' }],
				options: [
					{ flags: '--title <substring>', description: 'Case-insensitive substring match against target title' },
					{ flags: '--url <substring>', description: 'Case-insensitive substring match against target URL' },
					{ flags: '--match <substring>', description: 'Case-insensitive substring match against title + URL' },
					...cdpTargetOptions,
				],
				examples: [
					'argus page activate ABCD1234',
					'argus page activate --title "Docs"',
					'argus page activate --url localhost:3000',
					'argus page activate --match "Argus" --json',
				],
				action: async (targetId, options) => {
					await runChromeActivate({ ...options, targetId })
				},
			},
			{
				name: 'close',
				description: 'Close a Chrome target',
				arguments: [{ flags: '<targetId>', description: 'Target ID to close' }],
				options: cdpTargetOptions,
				examples: ['argus page close ABCD1234', 'argus page close ABCD1234 --json'],
				action: async (targetId, options) => {
					await runChromeClose({ ...options, targetId })
				},
			},
			{
				name: 'show',
				description: 'Lock the attached page as shown+focused (unthrottles rAF/timers when window is covered)',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [{ flags: '--json', description: 'Output JSON for automation' }],
				configure: (command) => {
					command.addHelpText(
						'after',
						'\nExamples:\n  $ argus page show app\n  $ argus page show app --json\n\nForces focus emulation on the attached page so boot/preview flows keep\nmaking progress even if the Chrome window is backgrounded or covered.\nLock persists until `argus page hide <id>`; survives watcher reattach.\n',
					)
				},
				action: async (id, options) => {
					await runPageShow(id, options)
				},
			},
			{
				name: 'hide',
				description: 'Release the visibility lock (restore default Chrome throttling behavior)',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [{ flags: '--json', description: 'Output JSON for automation' }],
				examples: ['argus page hide app', 'argus page hide app --json'],
				action: async (id, options) => {
					await runPageHide(id, options)
				},
			},
			{
				name: 'reload',
				description: 'Reload a Chrome target',
				arguments: [{ flags: '[targetId]', description: 'Target ID to reload (omit with --id to reload the attached page)' }],
				options: [
					{ flags: '--cdp <host:port>', description: 'CDP host:port' },
					{ flags: '--id <watcherId>', description: 'Use chrome config from a registered watcher' },
					{
						flags: '--param <key=value>',
						description: 'Update query param (repeatable, overwrite semantics)',
						parser: collectParam,
						defaultValue: [],
					},
					{ flags: '--params <a=b&c=d>', description: 'Update query params from string (overwrite semantics)' },
					{ flags: '--json', description: 'Output JSON for automation' },
				],
				examples: [
					'argus page reload ABCD1234',
					'argus page reload --id app',
					'argus page reload ABCD1234 --json',
					'argus page reload ABCD1234 --param foo=bar',
					'argus page reload ABCD1234 --param foo=bar --param baz=qux',
					'argus page reload ABCD1234 --params "a=1&b=2"',
				],
				action: async (targetId, options) => {
					await runPageReload({ ...options, targetId })
				},
			},
			emulationCommand,
		],
	},
]
