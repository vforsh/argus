import type { ArgusCommandDefinition } from '../defineCommand.js'
import { runChromeTargets, runChromeOpen, runChromeActivate, runChromeClose } from '../../commands/chrome.js'
import { runPageReload } from '../../commands/page.js'
import { runPageEmulationSet, runPageEmulationClear, runPageEmulationStatus } from '../../commands/pageEmulation.js'
import { runPageBack, runPageForward, runPageGoto } from '../../commands/pageNavigate.js'
import { runPageUrl } from '../../commands/pageUrl.js'
import { runPageShow, runPageHide } from '../../commands/pageVisibility.js'
import { listPresetNames } from '../../emulation/devices.js'
import { collectParam } from '../validation.js'
import { jsonOption } from './sharedOptions.js'

const cdpTargetOptions = [
	{ flags: '--cdp <host:port>', description: 'CDP host:port' },
	{ flags: '--id <watcherId>', description: 'Use chrome config from a registered watcher' },
	jsonOption,
] as const

const presetList = listPresetNames().join(', ')

/** Wait/timeout flags shared by `goto`, `back`, and `forward`. */
const navigationWaitOptions = [
	{ flags: '--wait <mode>', description: 'Wait for: load (default), domcontentloaded, none' },
	{ flags: '--timeout <duration>', description: 'Wait budget (e.g. 30s, 5000). Default: 30s' },
	jsonOption,
] as const

/** History-stepping flags shared by `back` and `forward`. */
const historyOptions = [
	{ flags: '-n, --steps <n>', description: 'Number of history entries to move (default: 1)' },
	...navigationWaitOptions,
] as const

export const gotoCommand: ArgusCommandDefinition = {
	name: 'goto',
	alias: 'nav',
	description: 'Navigate the attached page to a URL (absolute, scheme-less, or relative)',
	arguments: [
		{ flags: '[id]', description: 'Watcher ID' },
		{ flags: '[url]', description: 'Target URL. Omit to rewrite query params of the current URL' },
	],
	options: [
		{
			flags: '--param <key=value>',
			description: 'Set query param (repeatable, overwrite semantics)',
			parser: collectParam,
			defaultValue: [],
		},
		{ flags: '--params <a=b&c=d>', description: 'Set query params from string (overwrite semantics)' },
		...navigationWaitOptions,
	],
	examples: [
		'argus page goto app http://localhost:3000/checkout',
		'argus page goto app localhost:3000',
		'argus page goto app /settings',
		'argus page goto app "?tab=2"',
		'argus page goto app --param debug=1',
		'argus page goto app /slow --wait domcontentloaded',
		'argus page goto app /slow --wait none',
		'argus page goto app /settings --timeout 5s --json',
	],
	action: async (id, url, options) => {
		await runPageGoto(id, url, options)
	},
}

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
				jsonOption,
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
			options: [jsonOption],
			examples: ['argus page emulation clear app', 'argus page emu clear app --json'],
			action: async (id, options) => {
				await runPageEmulationClear(id, options)
			},
		},
		{
			name: 'status',
			description: 'Show current emulation state',
			arguments: [{ flags: '[id]', description: 'Watcher ID' }],
			options: [jsonOption],
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
				options: [
					{ flags: '--url <url>', description: 'URL to open', required: true },
					{ flags: '--attach', description: 'Attach a watcher to the new tab and stay running (requires --as)' },
					{ flags: '--as <watcherId>', description: 'Watcher id to register with --attach' },
					{ flags: '--no-page-indicator', description: 'Disable the in-page watcher indicator (with --attach)' },
					{ flags: '--artifacts <dir>', description: 'Artifacts base directory (with --attach)' },
					...cdpTargetOptions,
				],
				examples: [
					'argus page open --url http://localhost:3000',
					'argus page open --url localhost:3000',
					'argus page open --url http://example.com --json',
					'argus page open --url http://localhost:3000 --attach --as app',
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
				options: [jsonOption],
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
				options: [jsonOption],
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
					jsonOption,
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
			gotoCommand,
			{
				name: 'back',
				description: 'Go back in the session history',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [...historyOptions],
				examples: ['argus page back app', 'argus page back app -n 2', 'argus page back app --wait domcontentloaded --json'],
				action: async (id, options) => {
					await runPageBack(id, options)
				},
			},
			{
				name: 'forward',
				description: 'Go forward in the session history',
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [...historyOptions],
				examples: ['argus page forward app', 'argus page forward app -n 2', 'argus page forward app --json'],
				action: async (id, options) => {
					await runPageForward(id, options)
				},
			},
			{
				name: 'url',
				description: "Print the attached page's URL (bare URL, pipe-friendly)",
				arguments: [{ flags: '[id]', description: 'Watcher ID' }],
				options: [jsonOption],
				examples: ['argus page url app', 'argus page url app --json'],
				action: async (id, options) => {
					await runPageUrl(id, options)
				},
			},
			emulationCommand,
		],
	},
]
